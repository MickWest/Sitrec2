/**
 * Module: main Sitrec browser entrypoint.
 *
 * Responsibilities:
 * - Bootstrap globals, configuration, managers, and rendering.
 * - Load built-in or custom sitches from URL parameters.
 * - Integrate object-reference resolution for `custom`/`mod` loading and sharing.
 * - Coordinate startup lifecycle, GUI initialization, and main loop wiring.
 */
import {ColorManagement, Group, REVISION, Scene, WebGLRenderer,} from "three";
import "./js/uPlot/uPlot.css"
import {makeDraggable} from "./DragResizeUtils";
import {
    addGUIFolder,
    addTranslatedGUIFolder,
    addTranslatedGUIMenu,
    CustomManager,
    FileManager,
    GlobalDateTimeNode,
    Globals,
    guiMenus,
    guiTweaks,
    incrementMainLoopCount,
    infoDiv,
    NodeFactory,
    NodeMan,
    setCustomManager,
    setFileManager,
    setGlobalDateTimeNode,
    setGlobalURLParams,
    setInfoDiv,
    setNodeFactory,
    setNodeMan,
    setNullNode,
    setRenderOne,
    setSit,
    setSitchEstablished,
    setSitchMan,
    setSynth3DManager,
    setTrackManager,
    setUndoManager,
    setUnits,
    setupGUIGlobals,
    setupGUIjetTweaks,
    applyTileBoundsModeFromUrl,
    Sit,
    SitchMan,
    TrackManager,
} from "./Globals";
import {disableScroll, f2m, stripComments, updateDocumentTitle} from './utils'
import {CSituation} from "./CSituation";
import {helpDocs, DOC_SECTIONS, getDocsForMenu} from "./docsRegistry";
import {parseFromAppParams, buildFromAppSitch, finishFromApp} from "./fromApp.js";
import {par, resetPar} from "./par";

// was here
import * as LAYER from "./LayerMasks"
import {SetupFrameSlider} from "./nodes/CNodeFrameSlider";
import {registerNodes} from "./RegisterNodes";
import {registerSitches, textSitchToObject} from "./RegisterSitches";
import {SetupMouseHandler} from "./mouseMoveView";
import {initKeyboard, showHider} from "./KeyBoardHandler";
import {CommonJetStuff, initJetStuff, initJetStuffOverlays, initJetVariables, updateSize} from "./JetStuff";
import {
    GlobalDaySkyScene,
    GlobalNightSkyScene,
    GlobalScene,
    GlobalSunSkyScene,
    LocalFrame,
    setupDaySkyScene,
    setupLocalFrame,
    setupNightSkyScene,
    setupScene,
    setupSunSkyScene
} from "./LocalFrame";
import {CNodeManager} from "./nodes/CNodeManager";
import {CSitchFactory} from "./CSitchFactory";
import {CNodeDateTime} from "./nodes/CNodeDateTime";
import {addAlignedGlobe} from "./Globe";
import JSURL from "jsurl";
import {configParams, localSituation} from "./runtimeConfig";
import {
    checkLocal,
    checkServerlessMode,
    isConsole,
    isLocal,
    isServerless,
    setupConfigPaths,
    SITREC_APP,
    SITREC_SERVER
} from "./configUtils"
import {SituationSetup, startLoadingInlineAssets} from "./SituationSetup";
import {sitrecAPI} from "./CSitrecAPI";
import {CUnits} from "./CUnits";
import {updateLockTrack} from "./updateLockTrack";
import {updateFrame} from "./updateFrame";
import {checkLogin} from "./login";
import {CFileManager, waitForParsingToComplete} from "./CFileManager";
import {VideoLoadingManager} from "./CVideoLoadingManager";
import {disposeDebugArrows, disposeDebugSpheres, disposeScene} from "./threeExt";
import {removeMeasurementUI, setupMeasurementUI} from "./nodes/CNodeLabels3D";
import {imageQueueManager} from "./js/get-pixels-mick";
import {disposeGimbalChart} from "./JetChart";
import {CNode} from "./nodes/CNode";
import {DragDropHandler} from "./DragDropHandler";
// Side-effect import: registers event listeners that watch for video +
// KLV finishing to load and offer the user a frame-rate-choice dialog
// when the file's labeled fps disagrees with the KLV-UTS-derived rate.
// See FpsMismatchDialog.js for the rationale and detection logic.
import "./FpsMismatchDialog";
import {CGuiMenuBar, setupHelpSearch} from "./lil-gui-extras";
import {exportFOVForEditor} from "./FOVInterchange";
import {initUILogging} from "./UILogging";
import {assert} from "./assert";
import {CNodeFactory} from "./nodes/CNodeFactory";
import {extraCSS} from "./extra.css";
import {_TrackManager} from "./TrackManager";
import {ViewMan} from "./CViewManager";
import {LayoutMan} from "./CLayoutManager";
import {clearMenuMirrors} from "./MenuMirror";
import {glareSprite, targetSphere} from "./JetStuffVars";
import {CCustomManager} from "./CustomSupport";
import {EventManager} from "./CEventManager";
import {CNodeView3D} from "./nodes/CNodeView3D";
import {shouldSleepAnimationLoop as shouldSleepRenderLoopState} from "./renderLoopControl";
import {getApproximateLocationFromIP} from "./GeoLocation";
import {LLAToECEF} from "./LLA-ECEF-ENU";
import {
    addMotionAnalysisMenu,
    getMotionAnalyzerForTesting,
    resetMotionAnalysis,
    runMotionAnalysisForTesting,
    toggleMotionAnalysis
} from "./CMotionAnalysisUI";
import {addObjectTrackingMenu, resetObjectTracking} from "./CObjectTracking";
import {disposeStarTracker} from "./starTrack/StarTrackerUI";
import {resetHorizonExtractor} from "./CHorizonExtractor";
import {addTextExtractionMenu} from "./CTextExtraction";
import {addScriptedVideoMenu} from "./CScriptedVideo";
import {addLongExposureMenu} from "./LongExposure";
import {QuadTreeTile} from "./QuadTreeTile";
import {initI18n, t} from "./i18n";
import {showError, showConfirm} from "./showError";
import {destroyGlobalProfiler, globalProfiler, initGlobalProfiler} from "./VisualProfiler";
import {fileSystemFetch} from "./fileSystemFetch";
import {asyncOperationRegistry} from "./AsyncOperationRegistry";
import {C3DSynthManager} from "./C3DSynthManager";
import {undoManager} from "./UndoManager";
import {arModeManager} from "./ARMode";
import {TileUsageTracker} from "./TileUsageTracker";
import {debugLog} from "./DebugLog";
import {getEnvBool} from "./envUtils";
import {FeatureManager} from "./CFeatureManager";
import {CustomGraphManager} from "./CCustomGraphManager";
import {GraphDataManager} from "./CGraphDataManager";
import {
    encodeShareParam,
    extractUserIdFromSitrecReference,
    isResolvableSitrecReference,
    resolveSitrecReference,
    toCanonicalSitrecRef,
    toShareableCustomValue
} from "./SitrecObjectResolver";
import {
    flushGPUAndCheckBacklog,
    hasPendingTiles,
    hasPendingVideoFrames,
    renderMain,
    setIsTransitioning,
    waitForAllPendingOperations,
    windowChanged,
} from "./indexRender";
import {setupHUDColor} from "./HUDColor";

// Initialize debug log capture BEFORE any console output
debugLog.init();

// Global context menu blocker
// Uses capture mode (true) so it catches events before other listeners
// Only allows the native browser context menu when text is selected (for copy/paste)
let contextMenuWasOpen = false;

// The sitch catalog, prefetched right after setupConfigPaths so its round-trip overlaps
// login/settings/registration instead of serializing after them. Null when serverless or
// when the prefetch failed (the use site falls back to its own fetch).
let prefetchedSitchesText = null;
document.addEventListener('contextmenu', (event) => {
    if (event.target.tagName === 'CANVAS') {
        event.preventDefault();
        event.stopPropagation();
    } else {
        // Allow native context menu only if text is selected (for copy/paste)
        // or if the target is an editable element (for paste into inputs)
        const selection = window.getSelection();
        const hasSelection = selection && !selection.isCollapsed && selection.toString().trim() !== '';
        const tag = event.target.tagName;
        const isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || event.target.isContentEditable;
        if (hasSelection || isEditable) {
            contextMenuWasOpen = true;
        } else {
            event.preventDefault();
        }
    }
}, { capture: true });

// When a native context menu is dismissed by clicking, the browser fires mousedown
// on whatever element is underneath. Suppress that event to prevent unintended
// interactions (e.g. starting a slider drag).
document.addEventListener('mousedown', (event) => {
    if (contextMenuWasOpen) {
        contextMenuWasOpen = false;
        event.stopPropagation();
        event.preventDefault();
    }
}, { capture: true });

// CRITICAL: Prevent pull-to-refresh on mobile browsers (especially Android)
// This works in conjunction with the CSS overscroll-behavior property
// Some Android browsers need both CSS and JavaScript prevention
document.addEventListener('touchstart', (event) => {
    // Allow default touch behavior - we only need to prevent touchmove
}, { passive: true });

document.addEventListener('touchmove', (event) => {
    // Only prevent default if user is at the top of the page
    // This prevents pull-to-refresh while still allowing scrolling in scrollable elements
    if (window.scrollY === 0) {
        event.preventDefault();
    }
}, { passive: false });

console.log ("SITREC START " + process.env.BUILD_VERSION_STRING);

// Check for stale cached index.html by comparing built-in version with server version
if (typeof window !== 'undefined') {
    // Parse "Sitrec X.Y.Z: YY-MM-DD HH:MM PT" into comparable components
    function parseVersionString(s) {
        const m = s.match(/Sitrec\s+(\d+)\.(\d+)\.(\d+):\s+(\d+)-(\d+)-(\d+)\s+(\d+):(\d+)/);
        if (!m) return null;
        return [parseInt(m[1]), parseInt(m[2]), parseInt(m[3]),
                parseInt(m[4]), parseInt(m[5]), parseInt(m[6]),
                parseInt(m[7]), parseInt(m[8])];
    }

    // Returns true only if server version is strictly newer than running version
    function isNewerVersion(serverStr, runningStr) {
        const server = parseVersionString(serverStr);
        const running = parseVersionString(runningStr);
        if (!server || !running) return false;
        for (let i = 0; i < server.length; i++) {
            if (server[i] !== running[i]) return server[i] > running[i];
        }
        return false;
    }

    fetch('build-version.txt', { cache: 'no-store' })
        .then(r => r.ok ? r.text() : null)
        .then(async serverVersion => {
            if (!serverVersion) return;
            const server = serverVersion.trim();
            const running = process.env.BUILD_VERSION_STRING;
            if (server === running) return;
            console.warn("Version mismatch — Running: " + running + " | Server: " + server);
            if (!isNewerVersion(server, running)) return;
            // When MCP bridge is connected, skip the dialog (just log the warning)
            if (window._mcpDebug) return;
            if (await showConfirm("A newer version of Sitrec is available.\n\n"
                + "Running: " + running + "\n"
                + "Available: " + server + "\n\n"
                + "This may indicate a server caching issue — please report it to the admin.\n\n"
                + "Reload to update?", {title: "Update Available", yesLabel: "Reload", noLabel: "Not Now"})) {
                window.location.reload();
            }
        })
        .catch(() => {}); // silently ignore if file not available
}

// This is the main entry point for the sitrec web application
// However note that the imports above might have code that is executed
// before this code is executed.

// Detect if this is an explicit new sitch creation via ?action=new
const isNewSitchAction = !isConsole && new URLSearchParams(window.location.search).get("action") === "new";

// Start from the normal custom sitch, and switch to "empty" later only if the
// browser can actually auto-open for this request.
let situation = "custom";

// Some (essentially) global variables
let urlParams;
let startupDropURLLoaded = false;
const sortedSitches = {};
const selectableSitches = {};
const toolSitches = {};
const rootSitches = {};
const menuButtonSitches = {};
let toTest;
let testing = false;
let fpsInterval, rafInterval, startTime, now, then, thenRender, elapsed;

let animationFrameId;
// isTransitioning lives in indexRender.js; writes go through setIsTransitioning.

function clearScheduledAnimation() {
    if (animationFrameId !== undefined && animationFrameId !== null) {
        clearTimeout(animationFrameId);
        animationFrameId = null;
    }
}

function scheduleAnimationLoop(delay = 0) {
    if (animationFrameId !== undefined && animationFrameId !== null) {
        return;
    }

    animationFrameId = setTimeout(() => {
        animationFrameId = null;
        animate(performance.now());
    }, Math.max(0, delay));
}

// Render-on-demand sleep/wake. The loop is gated ONLY on tab VISIBILITY (document.hidden), not on
// OS window focus: a visible-but-unfocused window (e.g. driven alongside another app) must still
// run requested renders AND finite background work (terrain LOD subdivision, video decode), or
// changes don't paint and tiles never finish loading. The idle paused tab still sleeps because the
// background-work producers self-disable updateWhilePaused once settled (see renderLoopControl).
//
// Debug/MCP override: when forceRenderLoop is true, the render loop keeps running continuously,
// ignoring the hidden-tab and paused sleeps below. A hidden tab's render loop normally
// force-sleeps (so terrain LOD subdivision and tile loading stall), which makes it impossible to
// debug rendering via the SitrecBridge in a backgrounded tab. Toggle with
// globalThis.__sitrecForceRender(true|false); window.__sitrecForceRenderLoop mirrors the state.
let forceRenderLoop = false;

// --- MCP background-tab keep-awake -----------------------------------------
// Chrome never fires rAF in hidden tabs and clamps their main-thread timers
// (nested setTimeout → ≥1 s), so a backgrounded tab driven via SitrecBridge
// stalls: terrain never subdivides, loads never settle, and MCP tests hang
// until the tab is focused. Dedicated-worker timers are EXEMPT from that
// visibility throttling, so when the MCP bridge is attached (_mcpDebug, set
// by page-bridge.js in every bridge tab) a tiny worker heartbeat fires any
// pending scheduled frame at ~30 fps, and the hidden gate below is treated
// as visible. The render-on-demand sleep still applies: an IDLE background
// tab sleeps exactly like an idle foreground tab — only pending work runs.
function mcpKeepAwake() {
    return !!window._mcpDebug;
}

let keepAwakeWorker = null;
function startKeepAwakeTicker() {
    if (keepAwakeWorker) return;
    try {
        const src = "setInterval(() => postMessage(0), 33);";
        keepAwakeWorker = new Worker(URL.createObjectURL(new Blob([src], {type: "text/javascript"})));
        keepAwakeWorker.onmessage = () => {
            if (!document.hidden || !(forceRenderLoop || mcpKeepAwake())) return;
            // A frame is scheduled but its setTimeout may be visibility-clamped
            // to seconds away — fire it now so the loop paces at ~30 fps. When
            // the loop has SLEPT (nothing scheduled) this is a no-op; the next
            // wakeAnimationLoop() re-arms it.
            if (animationFrameId !== undefined && animationFrameId !== null) {
                clearScheduledAnimation();
                animate(performance.now());
            }
        };
    } catch (e) {
        console.warn("MCP keep-awake worker unavailable:", e);
        keepAwakeWorker = null;
    }
}
function stopKeepAwakeTicker() {
    if (!keepAwakeWorker) return;
    keepAwakeWorker.terminate();
    keepAwakeWorker = null;
}

function shouldSleepAnimationLoop() {
    return shouldSleepRenderLoopState({
        // With the MCP bridge attached a hidden tab is treated as visible, so
        // background-tab test runs behave like foreground ones.
        hidden: document.hidden && !mcpKeepAwake(),
        paused: par.paused,
        renderOne: par.renderOne,
        nodeList: NodeMan?.list,
        forceRender: forceRenderLoop,
    });
}

function wakeAnimationLoop() {
    // forceRenderLoop / the MCP bridge bypass the hidden gate so the loop can
    // be (re)started while backgrounded; the keep-awake worker then paces it.
    if (document.hidden && !forceRenderLoop && !mcpKeepAwake()) return;
    if (document.hidden) startKeepAwakeTicker();
    scheduleAnimationLoop(0);
}

globalThis.__sitrecWakeRenderLoop = wakeAnimationLoop;

// Debug/MCP: force the render loop to run continuously (see forceRenderLoop above),
// overriding the hidden-tab and paused sleeps so the scene keeps updating
// and rendering while a backgrounded tab is inspected via the bridge. While hidden,
// the keep-awake worker paces the loop at ~30 fps (worker timers are exempt from
// Chrome's hidden-tab throttling). Returns the new state; call
// __sitrecForceRender(false) to restore normal render-on-demand behaviour.
globalThis.__sitrecForceRender = (on = true) => {
    forceRenderLoop = !!on;
    window.__sitrecForceRenderLoop = forceRenderLoop;
    if (forceRenderLoop) {
        setRenderOne(true);
        wakeAnimationLoop();
    } else if (!mcpKeepAwake()) {
        stopKeepAwakeTicker();
    }
    return forceRenderLoop;
};
window.__sitrecForceRenderLoop = forceRenderLoop;

document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
        if (forceRenderLoop || mcpKeepAwake()) {
            // Backgrounded but under MCP/debug control — keep running as if
            // visible, paced by the throttling-exempt worker heartbeat.
            startKeepAwakeTicker();
            return;
        }
        clearScheduledAnimation();
        return;
    }

    // Tab became visible again — re-arm a render and revive the (possibly slept) loop.
    stopKeepAwakeTicker();
    setRenderOne(true);
    wakeAnimationLoop();
});

// The bridge attaches at document_start, so in an MCP tab _mcpDebug is
// already set here. If that tab was OPENED in the background (no
// visibilitychange ever fires), engage the keep-awake ticker now.
if (window._mcpDebug && document.hidden) startKeepAwakeTicker();

// Adaptive frame rate control
const frameRateController = {
    fps: 60,
    fpsTiers: [15, 20, 30, 60], // Available FPS tiers
    frameTimings: [], // Track last N frame times in ms
    maxFrameHistory: 30,
    checkInterval: 30, // Check for adjustment every N frames
    frameCount: 0,
    lastAdjustTime: 0,
    minTimeBetweenAdjustments: 2000, // Min 2 seconds between adjustments
    
    recordFrameTime(frameTimeMs) {
        this.frameTimings.push(frameTimeMs);
        if (this.frameTimings.length > this.maxFrameHistory) {
            this.frameTimings.shift();
        }
    },
    
    shouldAdjustFPS() {
        this.frameCount++;
        if (this.frameCount < this.checkInterval) return false;
        
        const now = Date.now();
        if (now - this.lastAdjustTime < this.minTimeBetweenAdjustments) return false;
        
        this.frameCount = 0;
        return true;
    },
    
    analyzeFrameTimes(targetFps = null) {
        if (this.frameTimings.length < 5) return null; // Need at least 5 samples
        
        // Use provided target FPS or current FPS
        const fps = targetFps !== null ? targetFps : this.fps;
        const targetFrameTime = 1000 / fps; // Expected time per frame
        const maxAllowedTime = targetFrameTime * 1.1; // Allow 10% overage
        
        const slowFrames = this.frameTimings.filter(t => t > maxAllowedTime).length;
        const slowFramePercentage = (slowFrames / this.frameTimings.length);
        
        return {
            slowFramePercentage,
            slowFramesCount: slowFrames,
            totalFrames: this.frameTimings.length,
            avgFrameTime: this.frameTimings.reduce((a, b) => a + b, 0) / this.frameTimings.length,
            maxFrameTime: Math.max(...this.frameTimings),
            targetFps: fps
        };
    },
    
    adjustFPS() {
        if (!this.shouldAdjustFPS()) return;
        
        const currentTierIndex = this.fpsTiers.indexOf(this.fps);
        
        // Ch eck degradation: if a percentage of work frames exceed target time
        const currentAnalysis = this.analyzeFrameTimes();
        if (!currentAnalysis) return;
        
        const shouldDegrade = currentAnalysis.slowFramePercentage > 0.1; // >10% slow frames
        
        // Check improvement: next tier must have 0% slow frames (perfect performance)
        let shouldImprove = false;
        if (currentTierIndex < this.fpsTiers.length - 1) {
            const nextAnalysis = this.analyzeFrameTimes(this.fpsTiers[currentTierIndex + 1]);
            if (nextAnalysis && nextAnalysis.slowFramePercentage === 0.0) {
                shouldImprove = true;
            }
        }
        
        if (shouldDegrade && currentTierIndex > 0) {
            // Drop to next lower tier
            const newFps = this.fpsTiers[currentTierIndex - 1];
            // console.log(`⬇️ Degrading FPS: ${this.fps}fps → ${newFps}fps (${(currentAnalysis.slowFramePercentage * 100).toFixed(1)}% slow frames at ${this.fps}fps)`);
            this.fps = newFps;
            this.lastAdjustTime = Date.now();
        } else if (shouldImprove) {
            // Upgrade only if next tier shows perfect performance
            const newFps = this.fpsTiers[currentTierIndex + 1];
            // console.log(`⬆️ Improving FPS: ${this.fps}fps → ${newFps}fps (0% slow at ${newFps}fps)`);
            this.fps = newFps;
            this.lastAdjustTime = Date.now();
        }
    },
    
    getCurrentFPS() {
        return this.fps;
    }
};

// Check to see if we are running in a local environment
checkLocal();


// Check the user agent for VR capability and mobile
await checkUserAgent();

if (INCLUDE_IWER_EMULATOR) {
    // Opt-in via ?iwer=1 — IWER's installRuntime() hooks the whole page
    // (spoofs a Meta Quest 3 user agent, installs an emulated WebXR runtime),
    // and as of Chrome 150 those hooks break MSAA rendering: every
    // alpha-blended pass into a multisampled render target is silently lost,
    // which turned the main-view sky black (sky quad and stars gone, opaque
    // terrain unaffected). Production builds exclude IWER entirely, so the
    // breakage was dev-only. Installing on demand keeps local WebXR testing
    // available without hooking every dev session.
    const wantIWER = !isConsole
        && new URLSearchParams(window.location.search).get("iwer") === "1";
    if (!Globals.canVR && isLocal && wantIWER) {
        // Initialize IWER (Immersive Web Emulation Runtime) for WebXR emulation
        // This must be done before any rendering or WebXR logic
        if (typeof navigator !== 'undefined') {
            import('iwer').then(({XRDevice, metaQuest3}) => {
                console.log("Installing IWER for WebXR emulation");
                const xrDevice = new XRDevice(metaQuest3);
                xrDevice.fovy = Math.PI / 2; // Set a comfortable FOV
                xrDevice.installRuntime();

                // Store device globally for debugging
                window._iwerDevice = xrDevice;
                Globals.canVR = true;
                console.log("✓ canVR TRUE. IWER installed. Device available as window._iwerDevice");
                console.log("✓ To test: Use the 'Start VR/XR' menu item");
            }).catch(err => {
                console.warn("Failed to load IWER:", err);
            });
        }
    } else if (!Globals.canVR && isLocal) {
        console.log("IWER VR emulator not installed (add ?iwer=1 to the URL to enable WebXR emulation)");
    }
}


// Expose Globals to window for debugging
window.Globals = Globals;

// Expose the build directory so SitrecBridge can match MCP sessions to tabs
window.__sitrecBuildDir = typeof __SITREC_BUILD_DIR__ !== 'undefined' ? __SITREC_BUILD_DIR__ : null;


// we set Globals.wasPending to 5 so if we get to the render loop with no pending async actions
// we will still get the "No pending actions" message
// 5 just means wait 5 frames before showing the message
Globals.wasPending = 5;

// Set regression mode early so network logging works from the start
Globals.regression = new URLSearchParams(window.location.search).get("regression") === "1";

await checkServerlessMode();
await setupConfigPaths();

// Overlap the sitch-catalog fetch with everything that follows — the login/settings
// round-trips, node registration, and menu building. It is awaited where its result is
// USED (the sitch registry below); starting it here turns a serialized wait into a
// download that rides behind the setup chain. A failed prefetch falls back to the
// original fetch at the use site.
//
// The GEOID is deliberately NOT prefetched here (tried 2026-08-09): asset parsers
// convert MSL altitudes before SituationSetup's ensureGeoidLoaded gate, and today they
// do so with the grid still absent (offset 0). Prefetching made the grid arrive in time
// for PARSE, silently shifting every parse-time altitude by the local geoid offset —
// tens of metres of rendered change on track sitches. Making parse-time conversions
// geoid-correct is a real fix worth doing, but it is a behaviour change to make on
// purpose, with baselines regenerated — not as a loading optimization's side effect.
if (!isServerless) {
    prefetchedSitchesText = fetch(SITREC_SERVER + "getsitches.php", {mode: "cors"})
        .then((response) => response.text())
        .catch(() => null);
}

// Check if we're running from file:// protocol and request directory access
await requestFileSystemAccessIfNeeded();

//await getConfigFromServer();

// quick test of the server config
// just call config.php

// fetch(SITREC_SERVER+"config.php", {mode: 'cors'}).then(response => response.text()).then(data => {
//     if (data !== "") {
//         console.log("Server Config ERROR: " + data)
//         // now just render a pain text message of data as an error
//         const errorDiv = document.createElement('div');
//         errorDiv.style.position = 'absolute';
//         errorDiv.style.width = 100;
//         errorDiv.style.height = 100;
//         errorDiv.style.color = "white";
//         errorDiv.innerHTML = data;
//         errorDiv.style.top = 40 + 'px';
//         errorDiv.style.left = 20 + 'px';
//         errorDiv.style.fontSize = 20 + 'px';
//         errorDiv.style.display = 'block';
//         errorDiv.style.padding = 5 + 'px';
//         errorDiv.style.background="black";
//         document.body.appendChild(errorDiv);
//         // and that's it
//         throw new Error("config.php error: "+data);
//         debugger;
//
//     }
// })

resetPar();
const queryString = window.location.search;
urlParams = new URLSearchParams(queryString);
setGlobalURLParams(urlParams)

Globals.regression = urlParams.get("regression") === "1";

// V5 Phase 0.1.a: parse tileBoundsMode + enableReachCull URL params before
// any sitch loads so the first subdivide pass sees the requested mode.
applyTileBoundsModeFromUrl();

const hasExplicitStartupRequest = isNewSitchAction
    || !!urlParams.get("sitch")
    || !!urlParams.get("sit")
    || !!urlParams.get("custom")
    || !!urlParams.get("mod")
    || !!urlParams.get("test")
    || !!urlParams.get("testAll")
    || urlParams.get("fromapp") === "1";   // app handoff builds its own sitch — don't auto-open the sitch browser

const hasServerBackedSaves = getEnvBool("SAVE_TO_SERVER", process.env.SAVE_TO_SERVER)
    || getEnvBool("SAVE_TO_S3", process.env.SAVE_TO_S3);

const shouldAutoOpenBrowser = !isConsole
    && hasServerBackedSaves
    && !isServerless
    && !Globals.regression
    && !hasExplicitStartupRequest;

if (!hasExplicitStartupRequest) {
    if (shouldAutoOpenBrowser) {
        situation = "empty";
    } else if (isLocal) {
        situation = localSituation;
    }
}

// This must be set before initializeOnce() creates CFileManager so startup
// fetches can be suppressed when the browser will immediately fetch the same data.
Globals.sitchBrowserWillOpen = shouldAutoOpenBrowser;

// a count of async pending actions, so we can tell when a level has fully loaded and settled up
Globals.pendingActions = 0;

Globals.fixedFrame = undefined;
if (urlParams.get("frame") !== null) {
    const parsedFrame = parseInt(urlParams.get("frame"), 10);
    if (!isNaN(parsedFrame)) {
        Globals.fixedFrame = parsedFrame;
    }
}

let customSitch = null;
// Stable canonical ref for custom sitches (`sitrec://...`) used for loadURL/version lookup/share links.
let customSitchRef = null;

// for legacy reasons either "custom" or "mod" can be used
// and we'll check for the modding parameter in the sitch object
if (urlParams.get("custom")) customSitch = urlParams.get("custom");
if (urlParams.get("mod")) customSitch = urlParams.get("mod");

await initializeOnce();
if (!initRendering()) {
    // we failed to create a renderer, so we can't continue
    // terminate the program
    // but we can't just return, as we are in an async function
    // so we need to throw an error
    throw new Error("Failed to create a renderer");

}

// Handoff from the standalone Starlink Horizon Flare tool (?fromapp=1&...): build a
// night-sky sitch from the params instead of loading a named/custom sitch.
const fromAppParams = parseFromAppParams(urlParams);

if (fromAppParams !== null) {
    Globals.sitchEstablished = true;
    setSit(new CSituation(buildFromAppSitch(fromAppParams)));
    Sit.initialDropZoneAnimation = false;
    markSitrecReady();
} else if (customSitch !== null) {
    if (isResolvableSitrecReference(customSitch)) {
        // Resolve to a temporary fetch URL for this session while preserving a stable canonical ref.
        const resolvedCustom = await resolveSitrecReference(customSitch);
        customSitchRef = resolvedCustom.ref;
        customSitch = resolvedCustom.url;
        console.log("Resolved custom sitch to temporary fetch URL from ref: " + customSitchRef);
    } else {
        // Keep non-resolved custom URLs in canonical-ref form when possible for downstream comparisons.
        customSitchRef = toCanonicalSitrecRef(customSitch);
    }

    let customSitchLoaded = false;
    try {
        const response = await fetch(customSitch, {mode: 'cors'});
        if (!response.ok) {
            showError("Failed to load custom sitch: HTTP " + response.status + " " + response.statusText + "\nURL: " + customSitch);
        } else {
            const data = await response.text();
            console.log("Custom sitch = " + customSitch)

            Globals.sitchEstablished = true;

            let sitchObject = textSitchToObject(data);

            setSit(new CSituation(sitchObject))

            Sit.initialDropZoneAnimation = false;

            markSitrecReady();

            customSitchLoaded = true;
        }
    } catch (e) {
        showError("Failed to load custom sitch: " + e.message + "\nURL: " + customSitch, e);
    }

    if (!customSitchLoaded) {
        selectInitialSitch();
    }
// }
//
//
// } else if (urlParams.get("mod")) {
//     // a mod has a "modding" parameter which is the name of a legacy sitch
//     // so we get the object for that sitch and then add the mod
//     // removing the "modding" parameter
//     const modSitch = urlParams.get("mod")
//     // customSitch is the URL of a sitch definition file
//     // fetch it, and then use that as the sitch
//     await fetch(modSitch, {mode: 'cors'}).then(response => response.text()).then(data => {
//         console.log("Mod sitch = "+modSitch)
//         console.log("Result = "+data)
//
//         const modObject = textSitchToObject(data);
//
//         let sitchObject = SitchMan.findFirstData(s => {return s.data.name === modObject.modding;})
//
//         assert(sitchObject !== undefined, "Modding sitch not found: "+modObject.modding)
//
//         // merge the two objects into a new one
//         sitchObject = {...sitchObject, ...modObject}
//
//         // remove the modding parameter to be tidy
//         delete sitchObject.modding
//
//         // and that's it
//         setSit(new CSituation(sitchObject))
//         par.name = Sit.menuName;
//         Sit.initialDropZoneAnimation = false;
//
//     });

} else {
    selectInitialSitch();
}


// handle parames like latlon=34.2334,-118.4354

const latlon = urlParams.get("latlon");
if (latlon) {


    // expecting something like: latlon=34.2334,-118.4354
    const latlonArray = latlon.split(",");
    if (latlonArray.length === 2 || latlonArray.length === 3) {
        const lat = parseFloat(latlonArray[0]);
        const lon = parseFloat(latlonArray[1]);
        if (!isNaN(lat) && !isNaN(lon)) {
            console.log("Setting GlobalDateTimeNode start lat/lon to " + lat + ", " + lon);

            let alt = 1.5; // 5ft, typical camera altitude in meters for hanheld-held cameras (common in UFO videos)

            // if there is a third value, it's the altitude in feet
            if (latlonArray.length === 3) {
                alt = parseFloat(latlonArray[2]);
                if (!isNaN(alt)) {
                    alt = f2m(alt);
                    console.log("Setting GlobalDateTimeNode start altitude to " + alt);
                } else {
                    showError("Invalid altitude format: " + latlonArray[2]);
                }
            }

            // the sitch has not been set up
            // so we jsut override the value in Sit

            Sit.TerrainModel.lat = lat;
            Sit.TerrainModel.lon = lon;
            Sit.TerrainModel.zoom = 15;
            Sit.TerrainModel.nTiles = 8

            Sit.mainCamera.startCameraPositionLLA = [
                    lat-3, lon, 250000,
                ]

            Sit.mainCamera.startCameraTargetLLA = [
                    lat , lon, 0,
                ]

            Sit.fixedCameraPosition.LLA = [
                lat, lon, alt
            ]

            // set the mode to AGL
            Sit.fixedCameraPosition.agl = true;


            setSitchEstablished(true); // so loading tracks won't set the Lat/Lon time again



        } else {
            showError("Invalid lat/lon format: " + latlon);
        }
    } else {
        showError("Invalid lat/lon format: " + latlon);

    }
}

const mapType = urlParams.get("mapType");
const elevationType = urlParams.get("elevationType");

if (Sit.TerrainModel) {
    if (mapType) {
        console.log("Setting mapType from URL param: " + mapType);
        Sit.TerrainModel.mapType = mapType;
    }
    
    if (elevationType) {
        console.log("Setting elevationType from URL param: " + elevationType);
        Sit.TerrainModel.elevationType = elevationType;
    }
}

legacySetup();
await setupFunctions();
loadStartupDropURLAfterSitchSetup();

const dateTime = urlParams.get("datetime");
if (dateTime) {
    // expecting something like: datetime=2022-02-22T12:34:56Z
    console.log("Setting GlobalDateTimeNode start date time to " + dateTime);
    GlobalDateTimeNode.populateStartTimeFromUTCString(dateTime);
    Globals.timeOverride = true; // flag to ignore deserializing date time
    console.log("GlobalDateTimeNode dateStart  = " + GlobalDateTimeNode.dateStart.toISOString());
    setSitchEstablished(true); // so loading tracks won't set the date time again
}



// fromApp handoff: nodes (lookCamera etc.) now exist — load the flight track (flight
// mode), place the camera, and start playback.
if (fromAppParams !== null) {
    await finishFromApp(fromAppParams);
}

windowChanged()

infoDiv.innerHTML = ""

// Setup GPU Memory Monitor GUI
if (Globals.GPUMemoryMonitor) {
    Globals.GPUMemoryMonitor.setupGUI(guiMenus);
//    console.log("GPU Memory Monitor GUI setup complete");
}

// Setup Visual Profiler (only if running locally)
if (isLocal) {
    // Add profiler toggle to debug menu
    const profilerControl = {
        enabled: false,
        update: function() {
            if (this.enabled) {
                if (!globalProfiler) {
                    initGlobalProfiler();
                }
                if (globalProfiler) {
                    globalProfiler.setEnabled(true);
                }
            } else {
                destroyGlobalProfiler();
            }
        }
    };
    
    // Add control to debug menu
    guiMenus.debug.add(profilerControl, 'enabled')
        .name('Visual Profiler')
        .onChange(() => profilerControl.update())
        .tooltip('Toggle the visual profiler display. Shows timing of code segments with a flame-graph-like visualization. Canvas is removed when disabled.')
        .perm();

    guiMenus.debug.add(Globals, 'showTileStats')
        .name('Tile Stats')
        .tooltip('Show tile statistics for subdivision and loading')
        .perm();

    // Manual WebGL context-loss trigger. Calls WEBGL_lose_context.loseContext()
    // on every 3D view's renderer; the browser then fires webglcontextlost
    // synchronously and webglcontextrestored after a short delay. The
    // recovery handlers in CNodeView3D dispose render targets, re-establish
    // pixel ratio, force every 2D-canvas view to re-scale its context, and
    // refresh terrain. Use this to verify recovery without waiting for
    // organic GPU pressure (which only happens on long Cheyenne-style
    // sessions). Cached per-renderer because re-getExtension across
    // restores can return null in some browsers.
    const contextLossControl = {
        forceContextLoss: function() {
            let count = 0;
            ViewMan.iterate((id, view) => {
                if (!view.renderer) return;
                const gl = view.renderer.getContext();
                if (!gl) return;
                if (!view._loseContextExt) {
                    view._loseContextExt = gl.getExtension('WEBGL_lose_context');
                }
                const ext = view._loseContextExt;
                if (!ext) {
                    console.warn(`[ForceContextLoss] WEBGL_lose_context not available on view "${id}"`);
                    return;
                }
                console.warn(`[ForceContextLoss] Losing context on view "${id}"`);
                ext.loseContext();
                // Schedule restore so we exercise the full lost→restored
                // cycle. The browser would eventually restore on its own,
                // but timing varies by browser; this makes the test
                // deterministic. 1s delay matches the typical organic gap.
                setTimeout(() => {
                    if (ext && typeof ext.restoreContext === 'function') {
                        console.warn(`[ForceContextLoss] Restoring context on view "${id}"`);
                        ext.restoreContext();
                    }
                }, 1000);
                count++;
            });
            console.warn(`[ForceContextLoss] Triggered loss on ${count} renderer(s); restore in ~1s`);
        }
    };
    guiMenus.debug.add(contextLossControl, 'forceContextLoss')
        .name('Force GL Context Loss')
        .tooltip('Force WebGL context loss on all 3D views, then restore after 1s. Tests the recovery path that handles organic GPU-process crashes.')
        .perm();
    
//    console.log("Visual Profiler controls added to Debug menu (local mode only)");
} else {
    console.log("Visual Profiler disabled (not running locally)");
}

console.log("............... Done with setup, starting animation")
Globals.sitchDirty = false; // Reset after setup — initialization may have triggered onChange callbacks
startAnimating(Sit.fps);

// When starting with the empty sitch, restrict the menu bar to essentials
if (Sit.name === "empty") {
    Globals.menuBar.showOnlyMenus(["main", "file", "help"]);
}

// Auto-open sitch browser when no explicit sitch/action is specified
if (Globals.sitchBrowserWillOpen && FileManager.sitchBrowser) {
    FileManager.sitchBrowser.open({hideCancelButton: Sit.name === "empty"});
}
Globals.sitchBrowserWillOpen = false;

// We continutally check to see if we are testing

const testCheckInterval = 1000;
setTimeout( checkForTest, Globals.quickTerrain?1:testCheckInterval);
setTimeout( checkFornewSitchObject, 500);

// some sitches start paused (e.g. the ModelInspector)
// so force rendering of the first few frames
setRenderOne(3)

// **************************************************************************************************
// *********** That's it for top-level code. Functions follow ***************************************
// **************************************************************************************************

// Helper functions for persisting directory handle
async function saveDirectoryHandle(handle) {
    try {
        // Open IndexedDB
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('SitrecStorage', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('handles')) {
                    db.createObjectStore('handles');
                }
            };
        });
        
        // Save the handle
        const tx = db.transaction(['handles'], 'readwrite');
        const store = tx.objectStore('handles');
        const request = store.put(handle, 'directoryHandle');
        
        await new Promise((resolve, reject) => {
            request.onsuccess = resolve;
            request.onerror = reject;
        });
        
        db.close();
        
        console.log("Directory handle saved to IndexedDB");
    } catch (err) {
        console.log("Failed to save to IndexedDB, trying cookie fallback:", err);
        // Save the directory name in a cookie as a fallback hint
        try {
            // Get the directory name to save as a hint
            const dirName = handle.name;
            document.cookie = `sitrec_last_dir=${encodeURIComponent(dirName)}; max-age=31536000; path=/`;
            console.log("Directory name saved to cookie as hint:", dirName);
        } catch (cookieErr) {
            console.log("Cookie save also failed:", cookieErr);
        }
    }
}

async function loadDirectoryHandle() {
    try {
        // Open IndexedDB
        const db = await new Promise((resolve, reject) => {
            const request = indexedDB.open('SitrecStorage', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains('handles')) {
                    db.createObjectStore('handles');
                }
            };
        });
        
        // Get the handle
        const tx = db.transaction(['handles'], 'readonly');
        const store = tx.objectStore('handles');
        const request = store.get('directoryHandle');
        
        const handle = await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        
        db.close();
        
        if (handle) {
            console.log("Directory handle loaded from IndexedDB");
            
            // Verify we still have permission by trying to query permissions
            const permissionStatus = await handle.queryPermission({ mode: 'read' });
            
            if (permissionStatus === 'granted') {
                console.log("Permission still granted for saved directory");
                return handle;
            } else if (permissionStatus === 'prompt') {
                console.log("Need to request permission again for saved directory");
                // Request permission again
                const newPermission = await handle.requestPermission({ mode: 'read' });
                if (newPermission === 'granted') {
                    console.log("Permission re-granted for saved directory");
                    return handle;
                }
            }
        }
    } catch (err) {
        console.log("Error loading directory handle:", err);
    }
    
    return null;
}

// Global function to manually change directory (can be called from console or UI)
window.changeServerlessDirectory = async function() {
    if (window.location.protocol !== 'file:') {
        alert("This function is only needed when running from the local filesystem.");
        return;
    }
    
    if (!window.showDirectoryPicker) {
        alert("Your browser doesn't support the File System Access API.");
        return;
    }
    
    // Get expected path from SITREC_APP if available
    let expectedPath = "";
    if (SITREC_APP && SITREC_APP.startsWith('file://')) {
        expectedPath = SITREC_APP.replace('file://', '');
        if (expectedPath.endsWith('/')) {
            expectedPath = expectedPath.slice(0, -1);
        }
    }
    
    try {
        // Show informative message if we have the expected path
        if (expectedPath) {
            const confirmMsg = `Please select the Sitrec dist-serverless directory.\n\nExpected location:\n${expectedPath}`;
            alert(confirmMsg);
        }
        
        // Request new directory access
        const dirHandle = await window.showDirectoryPicker({
            mode: 'read',
            startIn: 'documents'
        });
        
        // Store the directory handle globally
        window.fileSystemDirectoryHandle = dirHandle;
        
        // Save the handle for future sessions
        await saveDirectoryHandle(dirHandle);
        
        // Verify we can access the directory
        const entries = [];
        for await (const entry of dirHandle.values()) {
            entries.push(entry.name);
        }
        
        if (entries.includes('index.html') || entries.includes('index.bundle.js') || entries.includes('data')) {
            alert("Directory changed successfully! The page will now reload.");
            window.location.reload();
        } else {
            let errorMsg = "This doesn't appear to be the Sitrec dist-serverless directory. Please select the correct folder.";
            if (expectedPath) {
                errorMsg += "\n\nExpected: " + expectedPath;
            }
            alert(errorMsg);
        }
    } catch (err) {
        if (err.name !== 'AbortError') {
            alert("Failed to change directory: " + err.message);
        }
    }
};

async function requestFileSystemAccessIfNeeded() {
    // Check if we're running from file:// protocol
    if (window.location.protocol === 'file:') {
        console.log("Running from file:// protocol, checking for directory access...");
        
        // Check if File System Access API is available
        if (!window.showDirectoryPicker) {
            console.warn("File System Access API not available. Some features may not work.");
            showError("Your browser doesn't support the File System Access API. Binary files may not load correctly.");
            return;
        }
        
        // Extract the expected directory path from SITREC_APP
        let expectedPath = "";
        if (SITREC_APP && SITREC_APP.startsWith('file://')) {
            // Extract the path from SITREC_APP (e.g., file:///Users/mick/Dropbox/sitrec-dev/sitrec/dist-serverless/)
            expectedPath = SITREC_APP.replace('file://', '');
            // Remove trailing slash if present
            if (expectedPath.endsWith('/')) {
                expectedPath = expectedPath.slice(0, -1);
            }
            console.log("Expected directory path from SITREC_APP:", expectedPath);
        }
        
        // Try to load a previously saved directory handle
        const savedHandle = await loadDirectoryHandle();
        if (savedHandle) {
            // Verify this is still the right directory
            try {
                const entries = [];
                for await (const entry of savedHandle.values()) {
                    entries.push(entry.name);
                }
                
                if (entries.includes('index.html') || entries.includes('index.bundle.js') || entries.includes('data')) {
                    window.fileSystemDirectoryHandle = savedHandle;
                    console.log("Using previously selected directory:", savedHandle.name);
                    console.log("To change the directory, run: changeServerlessDirectory()");
                    return;
                } else {
                    console.log("Saved directory doesn't appear to be correct, requesting new selection");
                }
            } catch (err) {
                console.log("Error accessing saved directory, requesting new selection:", err);
            }
        }
        
        try {
            // Create a div to show explanatory message
            const messageDiv = document.createElement('div');
            messageDiv.style.cssText = `
                position: fixed;
                top: 50%;
                left: 50%;
                transform: translate(-50%, -50%);
                background: rgba(0, 0, 0, 0.9);
                color: white;
                padding: 30px;
                border-radius: 10px;
                z-index: 10000;
                max-width: 600px;
                text-align: center;
                font-family: Arial, sans-serif;
            `;
            
            // Add the expected path to the message if we have it
            const pathHint = expectedPath 
                ? `<p style="margin: 15px 0; padding: 10px; background: rgba(255,255,255,0.1); border-radius: 5px; font-family: monospace; font-size: 12px; word-break: break-all;">
                    Expected location:<br/><strong>${expectedPath}</strong>
                   </p>`
                : '';
            
            messageDiv.innerHTML = `
                <h2 style="margin-top: 0;">Directory Access Required</h2>
                <p>Sitrec is running from the local filesystem.</p>
                <p>To load data files properly, we need permission to access the directory where Sitrec is installed.</p>
                ${pathHint}
                <p style="margin-bottom: 10px;">Please select the <strong>dist-serverless</strong> folder when prompted.</p>
                <p style="margin-bottom: 20px; font-size: 14px; color: #aaa;">
                    <em>Your selection will be remembered for future sessions.</em>
                </p>
                <button id="requestAccessBtn" style="
                    padding: 10px 20px;
                    font-size: 16px;
                    background: #4CAF50;
                    color: white;
                    border: none;
                    border-radius: 5px;
                    cursor: pointer;
                ">Grant Access</button>
            `;
            document.body.appendChild(messageDiv);
            
            // Wait for button click
            await new Promise((resolve) => {
                document.getElementById('requestAccessBtn').addEventListener('click', async () => {
                    messageDiv.remove();
                    resolve();
                });
            });
            
            // Request directory access
            // Unfortunately, we can't use the path to set the initial directory with showDirectoryPicker
            // as it only accepts predefined well-known directories
            const dirHandle = await window.showDirectoryPicker({
                id: 'sitrec-directory',
                mode: 'read',
               // startIn: 'documents'  // Suggests starting in Documents folder
            });
            
            // Store the directory handle globally for later use
            window.fileSystemDirectoryHandle = dirHandle;
            
            // Save the handle for future sessions
            await saveDirectoryHandle(dirHandle);
            
            // Verify we can access the directory
            const entries = [];
            for await (const entry of dirHandle.values()) {
                entries.push(entry.name);
            }
            
            console.log("Directory access granted. Found files:", entries.slice(0, 5), "...");
            
            // Check if this looks like the right directory
            if (!entries.includes('index.html') && !entries.includes('index.bundle.js') && !entries.includes('data')) {
                let errorMsg = "This doesn't appear to be the Sitrec dist-serverless directory. Expected to find index.html or data folder.";
                if (expectedPath) {
                    errorMsg += "\n\nExpected location: " + expectedPath;
                    console.warn("Expected directory:", expectedPath);
                }
                showError(errorMsg);
            } else {
                // Directory looks correct - log the successful match
                console.log("Directory validated successfully - contains expected Sitrec files");
                if (expectedPath) {
                    console.log("Matches expected path from SITREC_APP");
                }
            }
            
        } catch (err) {
            if (err.name === 'AbortError') {
                showError("Directory access was cancelled. Some features may not work properly.");
            } else {
                console.error("Error requesting directory access:", err);
                showError("Failed to get directory access: " + err.message);
            }
        }
    }
}

async function checkUserAgent() {
    Globals.canVR = false;
    Globals.inVR = false;
    Globals.onMetaQuest = false;
    Globals.onMac = false;
    Globals.isMobile = false;


    if (!isConsole) {
        const userAgent = navigator.userAgent;
        console.log("User Agent = " + userAgent);
        if (userAgent.includes("OculusBrowser") || userAgent.includes("Quest")) {
            console.log("CanVR = true, as running on MetaQuest")
            Globals.onMetaQuest = true;
            Globals.canVR = true;
        }

        // check for Mac
        if (navigator.platform.toUpperCase().indexOf('MAC') >= 0) {
            Globals.onMac = true;
        }

        // Check for mobile devices (phones/tablets)
        if (/Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(navigator.userAgent) ||
            (/Android|webOS|iPhone|iPad|iPod|BlackBerry/i.test(navigator.platform)) ||
            (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 0)
        ) {
            Globals.isMobile = true;
            console.log("Mobile device detected");
        }

        // Check for WebXR support (for desktop VR headsets like Valve Index, HTC Vive, etc.)
        // Exclude Immersive Web Emulator extension unless running locally
        if (!Globals.canVR && navigator.xr) {
            try {
                const isVRSupported = await navigator.xr.isSessionSupported('immersive-vr');
                if (isVRSupported) {
                    // Check if this is the Immersive Web Emulator extension
                    const isEmulator = navigator.xr.constructor.name === 'XRSystem' && 
                                     window.hasOwnProperty('XRDevice');
                    
                    if (isEmulator && !isLocal) {
                        console.log("Immersive Web Emulator detected - VR disabled (enable locally for testing)");
                    } else {
                        console.log("CanVR = True as WebXR VR support detected (desktop VR headset)");
                        Globals.canVR = true;
                    }
                }
            } catch (err) {
                console.log("WebXR check failed:", err);
            }
        }
    }
}

async function checkForTest() {
//    console.log("Testing = " + testing + " toTest = " + toTest)
    if (toTest !== undefined && toTest !== "") {
//        var url = SITREC_APP + "?test=" + toTest
//        window.location.assign(url)

        // Wait for all pending operations and tiles from the previous situation
        // to complete before loading the next test situation
        await waitForAllPendingOperations();

        const testArray = toTest.split(',');
        situation = testArray.shift() // remove the first (gimbal)
        toTest = testArray.join(",")
        // log current time:
        console.log("Time = " + new Date().toLocaleTimeString());
        console.warn("  Testing " + situation + ", will text next: " + toTest)


        testing = true;
        newSitch(situation)


    } else {
        // Wait for all pending operations and tiles from the final situation
        // to complete before we say we are finished
        await waitForAllPendingOperations();

        Globals.quickTerrain = false;

        if (testing) {
            testing = false;
            console.log("All tests complete");
        }
    }
}

Globals.newSitchObject = undefined;

async function checkFornewSitchObject() {

    if (Globals.newSitchObject !== undefined) {
        const requestedSitchObject = Globals.newSitchObject;
        console.log("New Sitch Text = " + requestedSitchObject)
        try {
            await newSitch(requestedSitchObject, true);
            Globals.sitchDirty = false;
        } catch (error) {
            console.error("Error loading requested sitch object:", error);
        } finally {
            // Only clear if no newer request replaced it while we were loading.
            if (Globals.newSitchObject === requestedSitchObject) {
                Globals.newSitchObject = undefined;
            }
        }
    }
    setTimeout( checkFornewSitchObject, 500);
}


/////////////////////////////////////////////////////////////////////////////////////////////////////////////////
/////////////////////////////////////////////////////////////////////////////////////////////////////////////////

async function newSitch(situation, customSetup = false ) {
    setIsTransitioning(true);

    // Everything from here runs inside a try/finally so that isTransitioning is
    // ALWAYS cleared, even if the transition throws partway through (e.g. a
    // stale async handler from a superseded load corrupts state, or
    // setupFunctions() rejects). renderMain() short-circuits while
    // isTransitioning is true, so leaving it stuck = permanently black views
    // plus a half-built (blank) sidebar with no way to recover but a reload.
    // Resetting it on failure converts that dead-end into a logged, recoverable
    // error.
    try {
    setSitchEstablished(false);

    // Invalidate any in-flight load's generation NOW, before this transition's
    // awaits (parsing/terrain/settle below) — disposeEverything() bumps it again,
    // but that is seconds away, and in that window a superseded load could still
    // pass its stale-load guards, complete, and call setSitchEstablished(true)
    // over the false we just set. Double-bumping is harmless (the counter is
    // monotonic; guards only test inequality).
    Globals.loadGeneration++;

    // for the built-in sitches, we change the url, but we don't reload the page
    // that way the user can share the url direct to this sitch
    let url;
    if (!customSetup) {
        url = SITREC_APP + "?sitch=" + situation
    } else {
        // set the URL to the default
        if (FileManager.loadURL !== undefined) {
            // Share stable object-key values instead of host-bound storage URLs.
            url = SITREC_APP + "?custom=" + encodeShareParam(toShareableCustomValue(FileManager.loadURL));
        } else {
            // loading local sitch, so set to custom sitch
            // we don't have a URL, as it does not make sense to share a local sitch via URL
            url = SITREC_APP + "?sitch=custom";
        }

    }

    if (url !== undefined) {
        window.history.pushState({}, null, url);
    }

    // Close the sitch browser if it's open
    if (FileManager.sitchBrowser) {
        FileManager.sitchBrowser.close();
    }

    // close all the menus, and reattach them to the bar
    // otherwise it gets messy using an old menu config in a new sitch.
    Globals.menuBar.reset();

    // Cancel any existing animation frame to prevent memory leaks
    clearScheduledAnimation();
    console.log("%%%%% BEFORE the two AWAITS %%%%%%%%")
    await waitForParsingToComplete();

    if (!getEnvBool("NO_TERRAIN", process.env.NO_TERRAIN)) {
        await waitForTerrainToLoad();
    }
    console.log("%%%%% AFTER the two AWAITS %%%%%%%%")
    
    // Cancel all in-flight async operations before disposal
    // This ensures no dangling callbacks try to access disposed resources
    const cancelSummary = asyncOperationRegistry.cancelAll();
    console.log(`Cancelled ${cancelSummary.count} in-flight operations during transition`);
    
    // CRITICAL: Wait for all promise chains to settle after cancellation
    // When operations are aborted, their promise handlers still execute
    // Without this delay, those handlers run while Sit is being replaced,
    // causing them to read undefined properties from the new situation
    await new Promise(resolve => setTimeout(resolve, 50));
    
    disposeEverything();
    CustomManager._settingsMenuAdded = false;
    if (!customSetup) {
        // if it's not custom, then "situation" is a name of a default sitch
        selectInitialSitch(situation);
    } else {
        // if it's custom, then "situation" is a sitch data file
        // i.e. the text of a text based sitch
        setSit(new CSituation(situation))
        markSitrecReady();
    }

    console.log("Setting up new sitch: "+situation+ " Sit.menuName = "+Sit.menuName+ " Sit.name = "+Sit.name);

    par.name = Sit.menuName;

    legacySetup();
    await setupFunctions();
    loadStartupDropURLAfterSitchSetup();
    Globals.sitchDirty = false; // Reset after setup — initialization triggers onChange callbacks
    startAnimating(Sit.fps);
    setTimeout( checkForTest, Globals.quickTerrain?1:testCheckInterval);
    } catch (e) {
        console.error("newSitch: transition failed; the sitch may be only partially built. Resetting transition state so rendering can resume. Error:", e);
        throw e;
    } finally {
        // ALWAYS clear the transition flag — see the note where the try opens.
        setIsTransitioning(false);
    }
}

async function initializeOnce() {
//    console.log('initializeOnce() function called');

    // check to see if the url has a ignoreunload parameter
    // if it does, then we don't ask the user if they want to leave the page
    // this is useful for testing, as it allows the page to be reloaded without
    // the user having to confirm
    if (urlParams.get("ignoreunload") === null) {
        //
        window.addEventListener('beforeunload', function (e) {
            console.log("beforeunload: allowUnload=" + Globals.allowUnload + " sitchDirty=" + Globals.sitchDirty);
            // Check if we're in the middle of a download operation
            if (Globals.allowUnload) {
                return; // Allow the operation without showing the dialog
            }
            // When MCP bridge is connected, never show the dialog
            if (window._mcpDebug) {
                return;
            }
            // Only warn if the user has made meaningful changes
            // (not just camera position/orientation or frame number)
            if (!Globals.sitchDirty) {
                return;
            }
            e.preventDefault();
            e.returnValue = ''; // Standard for most browsers
        });
    }



    // Handle webpack Hot Module Replacement (HMR) to prevent "Reload site" dialog during hot reloads
    // When HMR is active, we listen for status changes and temporarily allow unload during updates
    if (module.hot) {
        // Listen for HMR status changes
        module.hot.addStatusHandler((status) => {
            console.log('HMR status:', status);
            // When HMR is preparing to update, allow unload to prevent the dialog
            if (status === 'prepare' || status === 'check' || status === 'dispose' || status === 'apply') {
                console.log('HMR: Allowing unload for hot reload');
                Globals.allowUnload = true;
            }
            // After HMR is idle or ready, restore the unload protection
            else if (status === 'idle' || status === 'ready') {
                console.log('HMR: Restoring unload protection');
                // Small delay to ensure any pending reloads complete
                setTimeout(() => {
                    Globals.allowUnload = false;
                }, 100);
            }
        });
    }

    setCustomManager(new CCustomManager());

    Globals.parsing = 0;

    ColorManagement.enabled = false;



    // Check if running in serverless mode (IndexedDB-based)
    await checkServerlessMode();

    await checkLogin();

    // Initialize tile usage tracking (non-blocking)
    TileUsageTracker.init();

    // Record visit for admin stats (non-blocking)
    if (!isServerless && getEnvBool("SITREC_TRACK_STATS", process.env.SITREC_TRACK_STATS)) {
        const sitchParam = new URLSearchParams(window.location.search).get('sitch') || '';
        fetch(SITREC_SERVER + 'record_visit.php' + (sitchParam ? '?sitch=' + encodeURIComponent(sitchParam) : ''), {
            credentials: 'include',
        }).catch(() => {});
    }

    // Initialize settings early, before any nodes are created
    // This ensures Globals.settings is available for terrain, UI, and other components
//    console.log('Initializing global settings from storage');
    await CustomManager.initializeSettings();

//    console.log('About to initialize NodeMan and DragDropHandler');
    setNodeMan(new CNodeManager())
    setTrackManager(_TrackManager)
    setNodeFactory(new CNodeFactory(NodeMan))
    setSitchMan(new CSitchFactory())
    setSynth3DManager(new C3DSynthManager())
    setUndoManager(undoManager)
    
    // Expose objects to window for console/MCP/testing access
    if (typeof window !== 'undefined') {
        // Regression settle gate hook: true while any visible video view's current
        // display frame is not yet decoded/ready (or its source is still loading).
        // The fast-regression harness polls this so it never screenshots over a stale
        // or blank video region — closing a non-determinism that showed up under
        // concurrent load (slower video decode) as small video-region diffs/blank
        // renders on video sitches (Beaver, Rocket Launch, Motion Tracking, etc.).
        window.areVideoFramesPendingForFixedFrame = function () {
            if (!NodeMan || !NodeMan.list) return false;
            for (const id in NodeMan.list) {
                const node = NodeMan.list[id]?.data;
                if (node && typeof node.isSettleVideoReady === 'function' && !node.isSettleVideoReady()) {
                    return true;
                }
            }
            return false;
        };
        window.NodeMan = NodeMan;
        window.LocalFrame = LocalFrame;
        window.GlobalScene = GlobalScene;
        window.DragDropHandler = DragDropHandler;
        window.UndoManager = undoManager;
        window.SitchMan = SitchMan;
        window.TrackManager = TrackManager;
        window.ViewMan = ViewMan;
        window.LayoutMan = LayoutMan;
        window.CustomManager = CustomManager;
        window.EventManager = EventManager;
        window.NodeFactory = NodeFactory;
        window.guiMenus = guiMenus;
        window.newSitch = newSitch;
        window.toggleMotionAnalysis = toggleMotionAnalysis;
        window.getMotionAnalyzerForTesting = getMotionAnalyzerForTesting;
        if (isLocal || urlParams.has("regression")) {
            window.__sitrecRunMotionAnalysisForTesting = runMotionAnalysisForTesting;
        }
        // The CSitrecAPI singleton is otherwise only window-exposed as a side effect of the
        // chat view loading (CNodeVIewChat -> CClientNLU -> CSitrecAPI), which does NOT happen
        // under ?regression=1. Expose it directly here so the MCP bridge and the fast-regression
        // scenario harness can drive the API in regression mode. Gated on isLocal so production
        // (www.metabunk.org) is byte-for-byte unchanged.
        if (isLocal) {
            window.sitrecAPI = sitrecAPI;
        }

        // Set a flag to indicate that these objects are ready
        window.SITREC_OBJECTS_READY = {
            NodeMan: true,
            DragDropHandler: true,
            UndoManager: true,
            timestamp: Date.now()
        };
        
        // Also create a DOM element as a signal for Puppeteer
        const readyElement = document.createElement('div');
        readyElement.id = 'sitrec-objects-ready';
        readyElement.setAttribute('data-ready', 'partial');
        readyElement.style.display = 'none';
        document.body.appendChild(readyElement);
        
//        console.log('Exposed to window:', { NodeMan: !!window.NodeMan, DragDropHandler: !!window.DragDropHandler });
//        console.log('Set SITREC_OBJECTS_READY flag:', window.SITREC_OBJECTS_READY);
//        console.log('Created DOM ready signal element');
        
        // Also expose Sit when it's available (e.g. built-in sitch loaded synchronously)
        if (typeof Sit !== 'undefined') {
            markSitrecReady();
        }
    } else {
        console.log('Window is not defined, cannot expose objects');
    }

    // Some metacode to find the node types and sitches (and common setup fragments)

    registerNodes();

// Get all the text based sitches from the server

// these are the sitches defined by <name>.sitch.js files inside the folder of the same name in data
    let textSitches = {};
    
    if (isServerless) {
        // In serverless mode, fetch text sitches from the data folder
        console.log("Serverless mode: loading text-based sitches from data folder");
        try {
            // Try to load SitCustom.js from the data folder
            const customSitchResponse = await fileSystemFetch('./data/custom/SitCustom.js');
            if (customSitchResponse.ok) {
                const customSitchText = await customSitchResponse.text();
                textSitches['custom'] = customSitchText;
                console.log("Loaded SitCustom from data folder");
            } else {
                console.warn("Failed to load SitCustom.js - status: " + customSitchResponse.status);
            }
        } catch (e) {
            console.error("Error loading SitCustom.js in serverless mode: " + e);
        }
    } else {
        // In server mode, fetch text sitches from PHP endpoint. Normally already in
        // flight since setupConfigPaths (see the prefetch there); the direct fetch is
        // the fallback for a failed prefetch.
        const sitchesURL = SITREC_SERVER + "getsitches.php";
        console.log("Getting TEXT BASED Sitches from: " + sitchesURL);

        let sitchesText = prefetchedSitchesText ? await prefetchedSitchesText : null;
        if (sitchesText === null) {
            sitchesText = await fetch(sitchesURL, {mode: 'cors'}).then(response => response.text());
        }
        textSitches = JSON.parse(sitchesText); // an object of text based sitches
    }

    registerSitches(textSitches);

    // Create the selectable sitches menu
// basically anything that is not hidden and has a menuName
    const unsortedSitches = {}
    SitchMan.iterate((key, sitch) =>{

        if (sitch.patchSatellites) {
            if (!sitch.files) sitch.files = {};
            sitch.files.starLink = "!"+SITREC_SERVER+"proxy.php?request=CURRENT_STARLINK"
        }


        if (sitch.hidden !== true && sitch.menuName !== undefined
        && (isLocal || !sitch.localOnly)) {

            if (isLocal && sitch.include_kml)
                sitch.menuName = sitch.menuName + " (KML)"

            unsortedSitches[sitch.menuName] = key;
        }
    })

// Extract sitch keys (the lower case version of the name) and sort them
    const sortedKeys = Object.keys(unsortedSitches).sort();
// Create a new sorted object
    sortedKeys.forEach(key => {
        const sitchName = unsortedSitches[key];
        const sitch = SitchMan.get(sitchName);

        if (sitch.isRoot) {
            rootSitches[key] = sitchName;
        } else if (sitch.isMenuButton) {
            menuButtonSitches[key] = sitchName;
        } else if (sitch.isTool) {
            toolSitches[key] = sitchName;
        } else {
            selectableSitches[key] = sitchName;
        }
        sortedSitches[key] = sitchName
    });
// Add the "Test All" option which smoke-tests all sitches
// and the "Test Here+" option (which does the same as test all, but starts at the current sitch)

    toolSitches["* Test All *"] = "testall";
    toolSitches["* Test Quick *"] = "testquick";
    toolSitches["* Test Here+ *"] = "testhere";

    console.log("SITREC START - Three.JS Revision = " + REVISION)

// Get the URL and extract parameters




///////////////////////////////////////////////////////////////////////
    // note in lil-gui.esm.js I changed
//   --name-width: 45%;
// to
//  --name-width: 36%;


    initI18n();
    Globals.menuBar = new CGuiMenuBar();

    // Opt-in logging of menu-item clicks (gated by LOG_UI_INTERACTIONS env var).
    initUILogging();


    // these area accessed like:
    // guiMenus.main, guiMenus.showhide, guiMenus.tweaks, guiMenus.showhideviews, guiMenus.physics
    const _gui = addTranslatedGUIMenu("main", "menus.main.title")
        .tooltip(t("menus.main.tooltip"));
    addTranslatedGUIMenu("file", "menus.file.title")
        .tooltip(t("menus.file.tooltip"));
    addTranslatedGUIMenu("view", "menus.view.title")
        .tooltip(t("menus.view.tooltip"));
    setupHUDColor(guiMenus.view);

    // Both refraction models live together here: the celestial one (whole
    // atmosphere, Saemundsson, for Sun/Moon/planets/stars) added by
    // CNodeDisplayNightSky, and the terrestrial one (range-dependent, for
    // terrain/buildings/sea) added by CNodeTerrainUI. Permanent shell created
    // once at init — the contents are non-permanent and get rebuilt per sitch.
    addGUIFolder("refraction", "Atmospheric Refraction", "view")
        .tooltip("How much the atmosphere bends light on its way to the camera — separately for celestial objects and for the solid scene.");

    // Reset Layout: snap the open views back into a clean default grid (Main on the left, the
    // rest stacked on the right), ignoring their current positions — recovery for a layout that
    // got messy. Views are free rectangles; shared edges become draggable seams automatically
    // (see CLayoutManager), so there is no separate "tiled" mode to toggle.
    guiMenus.view.add({reset: () => LayoutMan.resetLayout()}, "reset").name("Reset Layout")
        .tooltip("Snap all open views back into a clean default grid");



    addTranslatedGUIMenu("video", "menus.video.title")
        .tooltip(t("menus.video.tooltip"));


    addTranslatedGUIMenu("time", "menus.time.title")
        .tooltip(t("menus.time.tooltip"));
    addTranslatedGUIMenu("objects", "menus.objects.title")
        .tooltip(t("menus.objects.tooltip"));
    
    // Add "Add Object" menu item
    const objectMenuActions = {
        addObject: () => {
            const input = prompt(t("menus.objects.addObject.prompt"));
            if (input === null || input.trim() === "") return;
            
            const parsed = CustomManager.parseObjectInput(input);
            if (!parsed) {
                alert(t("menus.objects.addObject.invalidInput"));
                return;
            }
            
            const name = parsed.name || CustomManager.getNextObjectName();
            const { objectNode, trackOb } = CustomManager.createObjectFromInput(
                name, parsed.lat, parsed.lon, parsed.alt, parsed.hasExplicitAlt
            );
            
            CustomManager.positionCameraToViewObject(parsed.lat, parsed.lon, parsed.alt);
            
            // Open object editing dialog
            if (objectNode && objectNode.gui) {
                objectNode.gui.open();
            }
        }
    };

    
    guiMenus.objects.add(objectMenuActions, 'addObject')
        .name(t("menus.objects.addObject.label"))
        .tooltip(t("menus.objects.addObject.tooltip"))
        .perm();
    
    addTranslatedGUIMenu("satellites", "menus.satellites.title")
        .tooltip(t("menus.satellites.tooltip"));
    addTranslatedGUIMenu("terrain", "menus.terrain.title")
        .tooltip(t("menus.terrain.tooltip"));
    // these four have legacy globals
    const _guiPhysics = addTranslatedGUIMenu("physics", "menus.physics.title")
        .tooltip(t("menus.physics.tooltip"));

    // Permanent sub-folders inside Physics. Their non-permanent contents are
    // rebuilt by CCustomManager.setup() on every sitch load; the folder shells
    // live here so we don't end up with duplicate husks after destroy(false).
    addGUIFolder("wind", "Wind", "physics");
    addGUIFolder("simpleFlightSim", "Simple Flight Sim", "physics");

    // Scenarios: self-contained simulation packages (see CScenarioManager).
    // Permanent shells only — contents are populated lazily when the
    // Scenarios menu is first opened, and a scenario's nodes exist only
    // after it is explicitly activated (an untouched scenario is a no-op).
    addGUIFolder("scenarios", "Scenarios", "physics");
    addGUIFolder("gimbalAnalysis", "Gimbal Analysis", "scenarios");
    addGUIFolder("football", "Football", "scenarios");
    addGUIFolder("nimitz", "Nimitz", "scenarios");
    addGUIFolder("floodSim", "Flood Sim", "scenarios");

    // addGUIMenu("missile", "Missile").tooltip("Homing missile parameters\nControls for the missile simulation including mass, thrust, air resistance, and burn time");

    addTranslatedGUIMenu("camera", "menus.camera.title")
        .tooltip(t("menus.camera.tooltip"));

    // Three permanent, open sub-folders that organize the look-camera controls by
    // aspect: Location (position), Heading (orientation), FOV (Zoom). Each is led by
    // its Source selector (Position / Camera Heading / Camera FOV), then the relevant
    // manual controls — which grey out when a computed source drives that aspect.
    // Created as permanent shells so they survive menuBar.destroy(false); their
    // contents are routed in per sitch by the camera nodes/switches (gui: "cameraX").
    addGUIFolder("cameraLocation", "Location", "camera").open();
    addGUIFolder("cameraHeading", "Heading", "camera").open();
    addGUIFolder("cameraFOV", "FOV (Zoom)", "camera").open();
    // The LENS - what maps a field angle to a pixel radius, which FOV alone cannot say. Sitrec
    // assumes a pinhole everywhere until something measures otherwise, and the only thing that
    // does is Star Track's calibration, so this folder stays empty (and hidden) until a lens has
    // actually been fitted. It is a permanent shell for the same reason its neighbours are:
    // menuBar.destroy(false) keeps the folder and takes its contents.
    addGUIFolder("cameraLens", "Lens", "camera");

    // Lift whatever is currently driving the camera FOV into a .fov.json of
    // keyframes, for loading into the FOV Editor (of this or another sitch).
    // Added here, alongside the permanent folder, so it is available in legacy
    // sitches too — those are the ones whose zoom track is locked up in code
    // (Aguadilla computes it from a CSV column in a preRenderFunction) and so
    // are exactly what this is for. .perm() keeps it across sitch loads.
    guiMenus.cameraFOV.add({
        exportForFOVEditor: () => exportFOVForEditor(),
    }, "exportForFOVEditor").name("Export for FOV Editor").perm()
        .tooltip("Sample the current FOV source over every frame and save it as\n" +
            "keyframes (.fov.json). Drop that file on Sitrec to load it into the\n" +
            "FOV Editor. Instant zoom changes become two keyframes one frame apart.");

    // Permanent sub-folder inside Camera for the less-common per-camera tweaks
    // (look-camera Y-compress, lens X/Y offset, near plane, orbit camera, and
    // the ground-track switch). Created here as a permanent shell so it survives
    // menuBar.destroy(false); its contents are (re)populated per sitch by the
    // PTZ controller, the lookView, CCustomManager.setup(), and the camera node.
    addGUIFolder("cameraTweaks", "Camera Tweaks", "camera");

    addTranslatedGUIMenu("target", "menus.target.title")
        .tooltip(t("menus.target.tooltip"));
    addTranslatedGUIMenu("traverse", "menus.traverse.title")
        .tooltip(t("menus.traverse.tooltip"));

    const _guiShowHide = addTranslatedGUIMenu("showhide", "menus.showHide.title")
        .tooltip(t("menus.showHide.tooltip"));
    const _guiShowHideViews = addTranslatedGUIFolder("showhideviews", "menus.showHide.views.title", "showhide")
        .tooltip(t("menus.showHide.views.tooltip"));
    const _guiShowHideGraphs = addTranslatedGUIFolder("showhidegraphs", "menus.showHide.graphs.title", "showhide")
        .tooltip(t("menus.showHide.graphs.tooltip"));
    const _guiTweaks = addTranslatedGUIMenu("effects", "menus.effects.title")
        .tooltip(t("menus.effects.tooltip"));
    addTranslatedGUIMenu("lighting", "menus.lighting.title")
        .tooltip(t("menus.lighting.tooltip"));
    addTranslatedGUIMenu("contents", "menus.contents.title")
        .tooltip(t("menus.contents.tooltip"));

    addTranslatedGUIMenu("help", "menus.help.title")
        .tooltip(t("menus.help.tooltip"));
    addTranslatedGUIMenu("debug", "menus.debug.title")
        .tooltip(t("menus.debug.tooltip"));

    const localDocsEnabled = getEnvBool("LOCAL_DOCS", process.env.LOCAL_DOCS);

    function addDocLink(parent, nameKey, file) {
        const translatedName = t(nameKey);
        if (localDocsEnabled) {
            return parent.addExternalLink(translatedName, "./"+file+".html").perm().tooltip(translatedName);
        } else {
            return parent.addExternalLink(
                t("menus.help.documentation.githubLinkLabel", {name: translatedName}),
                "https://github.com/MickWest/Sitrec2/blob/main/"+file+".md"
            ).perm();
        }
    }

    // The user-facing docs are defined in one place — src/docsRegistry.js — which
    // also feeds the in-app AI assistant's getHelpDoc list (src/nodes/CNodeVIewChat.js),
    // so the menu and the AI can't drift apart. To add a doc: add an entry there and a
    // matching label key under menus.help.* in src/i18n/en.js.

    // Top-level links (e.g. "What's New") sit directly under the Help menu, above the
    // Documentation folder, so casual users see release notes without drilling in.
    for (const d of helpDocs) {
        if (d.top) addDocLink(guiMenus.help, d.labelKey, d.file);
    }

    const docs = addTranslatedGUIFolder("doumentation", "menus.help.documentation.title", "help")
        .tooltip(localDocsEnabled
            ? t("menus.help.documentation.localTooltip")
            : t("menus.help.documentation.githubTooltip")
        ).perm();

    // Grouped by section rather than one flat list — with ~30 docs a single list is
    // unreadable, and the grouping is the only signposting a new user gets. Sections
    // with no docs are skipped, so removing the last doc from a section removes the
    // folder rather than leaving an empty one.
    for (const s of DOC_SECTIONS) {
        const inSection = helpDocs.filter(d => d.section === s.id);
        if (inSection.length === 0) continue;
        const folder = addTranslatedGUIFolder("docsSection_" + s.id, s.labelKey, "doumentation").perm();
        for (const d of inSection) addDocLink(folder, d.labelKey, d.file);
    }

    // Contextual help: a "Help" folder at the top of each app menu that has docs, so the
    // documentation is reachable from where the controls are rather than only from the
    // Help menu. Driven entirely by `menuId` in the registry.
    for (const menuId of new Set(helpDocs.map(d => d.menuId).filter(Boolean))) {
        const menu = guiMenus[menuId];
        if (menu === undefined) continue;      // menu not created in this build/sitch
        const folder = addTranslatedGUIFolder(
            "menuHelp_" + menuId, "menus.help.documentation.menuHelpTitle", menuId
        ).tooltip(t("menus.help.documentation.menuHelpTooltip")).perm();
        for (const d of getDocsForMenu(menuId)) addDocLink(folder, d.labelKey, d.file);
    }

    if (localDocsEnabled) {
        docs.addExternalLink(t("menus.help.documentation.thirdPartyNotices"), "./ThirdPartyNotices.txt").perm()
            .tooltip(t("menus.help.documentation.thirdPartyNoticesTooltip"));
    } else {
        docs.addExternalLink(
            t("menus.help.documentation.githubLinkLabel", {
                name: t("menus.help.documentation.thirdPartyNotices"),
            }),
            "https://github.com/MickWest/Sitrec2/blob/main/ThirdPartyNotices.txt"
        ).perm();
    }

    docs.addExternalLink(t("menus.help.documentation.downloadBridge"), "./tools/SitrecBridge/dist/SitrecBridge.zip").perm()
        .tooltip(t("menus.help.documentation.downloadBridgeTooltip"));

    if (configParams?.extraHelpLinks !== undefined) {

        const external = addTranslatedGUIFolder("external", "menus.help.externalLinks.title", "help")
            .tooltip(t("menus.help.externalLinks.tooltip")
            ).perm();

        for (const [key, value] of Object.entries(configParams.extraHelpLinks)) {
            if (typeof value === "string") {
                const e = external.addExternalLink(key, value).perm();
                e.tooltip(key);
            } else {
                const e = external.addExternalLink(key, value.url).perm();
                if (value.tooltip !== undefined) {
                    e.tooltip(value.tooltip);
                } else {
                    e.tooltip(key);
                }
            }
        }
    }

    // Export debug log button
    guiMenus.help.add({ exportDebugLog: () => debugLog.export() }, 'exportDebugLog')
        .name(t("menus.help.exportDebugLog.label"))
        .tooltip(t("menus.help.exportDebugLog.tooltip"))
        .perm();

    setupHelpSearch(guiMenus.help);

    // legacy accessor variables. can also use guiMenus.physics, etc
    setupGUIGlobals(_gui,_guiShowHide,_guiTweaks, _guiShowHideViews, _guiShowHideGraphs, _guiPhysics)
    addMotionAnalysisMenu();
    addObjectTrackingMenu();
    addTextExtractionMenu();
    addScriptedVideoMenu();
    addLongExposureMenu();
    setUnits(new CUnits("Nautical"));
    setFileManager(new CFileManager())
    
    const customURL = urlParams.get("custom") || urlParams.get("mod");
    if (customURL) {
        // `loadURL` should track a stable ref/key when available, not the short-lived resolved fetch URL.
        FileManager.loadURL = customSitchRef || toCanonicalSitrecRef(customURL);
        const sourceUserID = extractUserIdFromSitrecReference(FileManager.loadURL);
        if (sourceUserID) {
            FileManager.sourceUserID = sourceUserID;
        }
    }

    window.FileManager = FileManager;


    //first add buttons for the root sitches

    for (const [key, sitch] of Object.entries(rootSitches)) {
        Globals[""+key+"Button"] = function()  {
            const url = SITREC_APP+"?sitch=" + sitch
            newSitch(sitch);
            window.history.pushState({}, null, url);
        }

        const sitchObject = SitchMan.get(sitch);

        _gui.add(Globals, ""+key+"Button").name(key).perm()
            .tooltip(sitchObject.tooltip || t("menus.main.noTooltip"))

        // Directly below the live "Starlink Horizon Flares (LIVE)" sitch, link to the
        // standalone SHF predictor app (tools/shf) — a separate PWA, so it's an external
        // link (opens in a new tab) rather than a sitch button.
        if (sitch === "starlink") {
            _gui.addExternalLink("SHF App", SITREC_APP + "tools/shf/").perm()
                .tooltip("Open the standalone Starlink Horizon Flares (SHF) predictor app");
        }

    }

    // add menu buttons (displayed after root sitches)
    for (const [key, sitch] of Object.entries(menuButtonSitches)) {
        Globals[""+key+"Button"] = function()  {
            const url = SITREC_APP+"?sitch=" + sitch
            newSitch(sitch);
            window.history.pushState({}, null, url);
        }

        const sitchObject = SitchMan.get(sitch);

        _gui.add(Globals, ""+key+"Button").name(key).perm()
            .tooltip(sitchObject.tooltip || t("menus.main.noTooltip"))

    }




    const unselectedText = t("menus.main.selectPlaceholder");

    par.nameSelect = unselectedText;
    // Add the menu to select a situation
    _gui.add(par, "nameSelect", selectableSitches).name(t("menus.main.legacySitches.label")).perm().onChange(sitch => {
        par.name = par.nameSelect;
        console.log("SITCH par.name CHANGE TO: "+sitch+" ->"+par.nameSelect)
        const url = SITREC_APP+"?sitch=" + sitch
        newSitch(sitch);
        window.history.pushState({}, null, url);
        par.nameSelect = unselectedText ;

    })
        .tooltip(t("menus.main.legacySitches.tooltip"));

    // and one for tools
    par.toolSelect = unselectedText;
    _gui.add(par, "toolSelect", toolSitches).name(t("menus.main.legacyTools.label")).perm().listen().onChange(sitch => {
        console.log("SITCH par.name CHANGE TO: "+sitch+" ->"+par.name)
        const url = SITREC_APP+"?sitch=" + sitch

// smoke test of everything after the current sitch in alphabetical order
        if (sitch === "testhere") {
            toTest = ""
            let skip = true;
            for (const key in sortedSitches) {
                if (skip) {
                    if (sortedSitches[key] === situation)
                        skip = false;
                } else {
                    //if (sortedSitches[key] !== "testall" && sortedSitches[key] !== "testquick" && sortedSitches[key] !== "testhere")
                    if (SitchMan.exists(sortedSitches[key]))
                        toTest += sortedSitches[key] + ",";
                }
            }
            toTest+=situation  // end up back where we started
            checkForTest();
        } else {
            newSitch(sitch);
        }

        // not loading the new sitch, so just change the URL of this page
        window.history.pushState({}, null, url);
        par.toolSelect = unselectedText;
    })
        .tooltip(t("menus.main.legacyTools.tooltip"));






    // setup the common keyboard handler
    initKeyboard();


    function injectExtraCSS(cssContent) {
        const styleElement = document.createElement('style');
        styleElement.textContent = cssContent;
        document.head.append(styleElement);
    }



    // add a meta tag to make the page responsive
    // suggested as a fix for the font shrinking on Meta Quest
    // var meta = document.createElement('meta');
    // meta.name = 'viewport';
    // meta.content = 'width=device-width, initial-scale=1.0';
    // document.getElementsByTagName('head')[0].appendChild(meta);
    //



    // after the gui has been created it will have injected its styles into the head
    // so we can now add our own styles

    requestAnimationFrame(() => {
        // strip off any C++ style comments.
        const stripped = stripComments(extraCSS)
        injectExtraCSS(stripped);
    })

}

function initRendering() {

    // console.log("Window inner size = " + window.innerWidth + "," + window.innerHeight)

    setInfoDiv(document.createElement('div'))

    //give it a name so we can find it in the DOM
    infoDiv.id = "infoDiv";

    infoDiv.style.position = 'absolute';
    infoDiv.style.width = 100;
    infoDiv.style.height = 100;
    infoDiv.style.color = "white";
    infoDiv.innerHTML = "Loading";
    infoDiv.style.top = 40 + 'px';
    infoDiv.style.left = 20 + 'px';
    infoDiv.style.fontSize = 20 + 'px';
    infoDiv.style.display = 'none';
    // 5 px border
    infoDiv.style.padding = 5 + 'px';
   // if (isLocal) {
        infoDiv.style.display = 'block';
        infoDiv.style.zIndex = 4000; // behind the gui menus, but in front of everything else
   // }
    infoDiv.style.background="black";
    makeDraggable(infoDiv);
    document.body.appendChild(infoDiv);


    // attept to create a renderer to catch issues early and do a graceful exit
    try {
        const renderer = new WebGLRenderer({});
        renderer.dispose();
    } catch (e) {
        showError("Incompatible Browser or Graphics Acceleration Disabled\n Error creating WebGLRenderer: "+e)
        // show an alert
        alert("Incompatible Browser or Graphics Acceleration Disabled\n Error creating WebGLRenderer:\n "+e)


        return false;
    }


    setupScene(new Scene())
    setupLocalFrame(new Group())

    GlobalScene.add(LocalFrame)
    window.LocalFrame = LocalFrame;
    window.GlobalScene = GlobalScene;

    disableScroll()
    SetupMouseHandler();
    window.addEventListener( 'resize', windowChanged, false );

    return true;
}

// some sitch specific stuff that needs to be done before the main setup
function legacySetup() {
    assert(Sit !== undefined, "legacySetup called before Sit is defined");
    let _guiJetTweaks;
    if (Sit.jetStuff) {
        _guiJetTweaks = guiTweaks.addFolder('Jet Tweaks').close();
    }
    setupGUIjetTweaks(_guiJetTweaks)
    // guiTweaks.add(par,"effects")

///////////////////////////////////////////////////////////////////////////////////////
// At this point Sit is set up.
// setup common nodes and other things that get set up when a sitch is loaded

    setGlobalDateTimeNode(new CNodeDateTime({
        id:"dateTimeStart",
    }))

    SetupFrameSlider(); // this is the slider and buttons for frame control


//    NodeFactory.create("Sunlight", {id: "sunlight"})

    setNullNode(new CNode({id: "null"}))

// check if Sit.name is all lower case
    assert(Sit.name.slice().toLowerCase() === Sit.name, "Sit.name ("+Sit.name+") is not all lower case")


    updateDocumentTitle();
}

async function setupFunctions() {
    resetPar();

    // Each sitch starts in legacy (free-floating) layout mode; auto-tiling (if any) is
    // re-evaluated at the end of setup once this sitch's views + positions are established.
    LayoutMan.clearLayout();

    // Drop menu-mirror registrations from the previous sitch (its controllers/menus are being
    // disposed); they re-register as this sitch's menus are rebuilt.
    clearMenuMirrors();

    const title = urlParams.get("regression") ? "Sitrec Regression Test" : process.env.BUILD_VERSION_STRING;
    Globals.menuBar.infoGUI.title(title);


    // just setting visibility of the Save/Load menu items
    FileManager.sitchChanged();

    // not sure this is the best place to do this......
    // but resetPar has just set par.paused to false
    // so no earlier.
    par.paused = Sit.paused;

    Globals.showMeasurements = true;
    Globals.showMeasurementsLook = false;


    // Setup the watch nodes that allow access via Math expressions
    // to code values like the number of frame, fps, etc
    NodeFactory.create("Watch", {id: "frames", ob: "Sit", watchID: "frames"})
    NodeFactory.create("Watch", {id: "fps", ob: "Sit", watchID: "fps"})

    let urlData;
    if (urlParams.get("data")) {
        urlData = urlParams.get("data")
    }


    let gotLocation = false;

    // get approximate location from IP if needed
    // only if
    // - Not testing
    // - Sit.localLatLon is true
    // - no URL "data" parameter
    if (!testing  && Sit.localLatLon && urlData === undefined) {
        await getApproximateLocationFromIP().then((result) => {
            if (result) {
                Sit.lat = result.lat;
                Sit.lon = result.lon;
                if (Sit.TerrainModel) {
                    Sit.TerrainModel.lat = result.lat;
                    Sit.TerrainModel.lon = result.lon;
                }
                gotLocation = true;
//                console.log("Approximate location set to: " + Sit.lat + ", " + Sit.lon);
            } else {
                console.warn("Failed to get approximate location, using default");
            }
            Sit.localLatLon = false; // so we don't do this again after saving and loading

        })
    }


// Parse the URL parameters, if any
// setting up stuff like the local coordinate system
// this will override things like Sit.lat and Sit.lon

// bit of a patch
// if we are going to load a starlink file (i.e. id = starLink - note capitalization)
//  check the flag rhs, which is set to rhs: FileManager.rehostedStarlink,
//  if it's set, then delete the starLink from Sit.files
    if (urlData) {
        const urlObject = JSURL.parse(urlData)
        if (urlObject.rhs && (Sit.files.starLink !== undefined)) {
            delete Sit.files.starLink
            FileManager.rehostedStarlink = true;
            console.log("Deleted starLink from sit, as urlObject.rhs = "+urlObject.rhs)
        }

        if (Sit.parseURLDataBeforeSetup) {
            // currently only used by SitNightSky, and only slightly, to setup Sit.lat/lon from olat/olon URL parameters
            Sit.parseURLDataBeforeSetup(urlData)
        }
    }


    const sitchData = Sit;
    // patch to handle extra starLink files to avoid double loading
    // we move the starLink file from Sit.loadedFiles to Sit.files
    // and then delete it from Sit.loadedFiles
    if (sitchData.loadedFiles !== undefined) {
        if (sitchData.loadedFiles.starLink !== undefined && sitchData.files.starLink !== undefined) {
            sitchData.files.starLink = sitchData.loadedFiles.starLink;
            delete sitchData.loadedFiles.starLink;
            console.log ("CCustomManager.setup: Removed Sit.files.starLink, as it is now in Sit.loadedFiles.starLink");
        }
    }


// Start loading the assets in Sit.files, and wait for them to load

//    console.log("START Load Assets")
    const assetsLoading = Sit.loadAssets();
//    console.log("WAIT Load Assets")
    await assetsLoading;
//    console.log("START load inline assets")
    await startLoadingInlineAssets(Sit)

    console.log("FINISHED Load Assets")

    // parsing can be async, so we need to wait for it to complete
    // before we do setup
    await waitForParsingToComplete();

    setupMeasurementUI(); // bit of an odd one - setting up the measurement measure ment grounp and UI

//
// Now that the assets are loaded, we can setup the situation
// First we do the data-driven stuff by expanding and then parsing the Sit object
//    console.log("SituationSetup()")
    await SituationSetup(false);

// If gimbalSetup is defined, pre-apply its flags to Sit so that initJetStuff picks them up.
    if (Sit.gimbalSetup && Sit.setup === undefined) {
        const gc = Sit.gimbalSetup;
        Sit.showATFLIR = gc.showATFLIR !== false;
        Sit.showGimbalDragMesh = gc.showGimbalDragMesh !== false;
        Sit.showGimbalCharts = gc.showGimbalCharts !== false;
        Sit.showGlare = gc.showGlare ?? false;
    }

// jetStuff is set in Gimbal, GoFast, Agua, and FLIR1
    if (Sit.jetStuff) {
        initJetVariables();
        initJetStuff()
    }


    // Settings must be initialized before the settings menu is created
    if (!CustomManager.settingsInitialized) {
        await CustomManager.initializeSettings();
        CustomManager.settingsInitialized = true;
    }

    // Settings menu is always available (language, detail level, etc.)
    CustomManager.setupSettingsMenu();

    if (Sit.isCustom || Sit.canMod) {
        await CustomManager.setup()
    }

// Each sitch can have a setup() and setup2() function
// however only Gimbal actually used setup2() as gimbal and gimabalfar have different setup2() functions

    if (Sit.setup  !== undefined) Sit.setup();

    // If gimbalSetup is present and no explicit setup() handled it, run the Gimbal analysis pipeline.
    // This allows custom sitches (created via web UI) to use gimbal features without a setup() function.
    if (Sit.gimbalSetup && Sit.setup === undefined) {
        const {handleGimbalSetup} = await import("./GimbalCustomSetup");
        handleGimbalSetup(Sit.gimbalSetup);
    }

    if (Sit.setup2 !== undefined) Sit.setup2();
    // we are allowing more, see SitFAA2023
    if (Sit.setup3 !== undefined) Sit.setup3();

// Redo the data-driven setup, but this is for any deferred setup
// i.e data members that have defer: true
    await SituationSetup(true);


    if (gotLocation) {
        // goto the location we got from the IP address
        // i.e. move the camera to the location??
        if (NodeMan.exists("fixedCameraPosition")) {
            const fixedCameraPosition = NodeMan.get("fixedCameraPosition");
            fixedCameraPosition.setLLA(Sit.lat, Sit.lon, 6);
            fixedCameraPosition.agl = true; // set AGL to true, so we adjust the altitude above ground level

        } else {
            NodeMan.get("cameraLat").value = Sit.lat;
            NodeMan.get("cameraLon").value = Sit.lon;
        }
        const ecef = LLAToECEF(Sit.lat, Sit.lon, 0);
        NodeMan.get("mainCamera").goToPoint(ecef,1000000,2000000);

        // normally setting the camera positon means we have established the sitch
        // however if it's ust geolocating the camera, then we don't want to set the sitch established
        // as we still want to load tracks and have it set the start time and location to the track
        setSitchEstablished(false);

    }



    console.log("GlobalDateTimeNode.populateStartTimeFromUTCString(Sit.startTime) " + Sit.startTime)
    GlobalDateTimeNode.populateStartTimeFromUTCString(Sit.startTime, true)

    if (Sit.jetStuff) {
        // only gimbal
        // minor patch, defer setting up the ATFLIR UI, as it references the altitude
        initJetStuffOverlays()
        console.log("CommonJetStuff()")
        CommonJetStuff();
    }


    // Only load globe if useGlobe is true AND dynamicSubdivision is false
    // If dynamicSubdivision is true, the globe will be loaded later when it's turned off
    if (Sit.useGlobe && !Globals.dynamicSubdivision) {
//        console.log("addAlignedGlobe()")

        // if a globe scale is set, then use that
        // otherwise, if terrain is set, then use 0.9999 (to avoid z-fighting)
        // otherwise use 1.0, so we get a perfect match with collisions.
        par.globe = addAlignedGlobe(Sit.globeScale ?? (Sit.terrain !== undefined ? 0.9999 : 1.0))
        showHider(par.globe,"[G]lobe", true, "g").name(t("showHiders.globe.label"))
    }

// Finally move the camera and reset the start time, if defined in the URL parameters
    if (urlParams.get("data")) {
        urlData = urlParams.get("data")
        if (Sit.parseURLDataAfterSetup) {
            Sit.parseURLDataAfterSetup(urlData)
        }
    }



// now everything that is normally done is done, we can do any custom stuff that's included
// i.e. load files, apply mods, etc.
        CustomManager.deserialize(Sit);

    // "Camera Tweaks" is a permanent folder created at app init (it must be, to
    // survive menuBar.destroy(false)), which leaves it at the TOP of the Camera
    // menu. Now that every per-sitch camera control has been added, push it to the
    // bottom. The deferred re-move catches any same-tick setTimeout(0) reorders
    // (e.g. CNodeCamera's ground-track switch moving itself within the folder).
    if (guiMenus.camera && guiMenus.cameraTweaks) {
        guiMenus.cameraTweaks.moveToEnd();
        setTimeout(() => guiMenus.cameraTweaks?.moveToEnd(), 0);
    }

    // Each Source selector leads its sub-folder. The manual controls (Lat/Lon,
    // Pan/Tilt) are created before their switch in SitCustom order, so pull each
    // selector to the top of its folder once everything has been added.
    const leadSelector = (id) => {
        const c = NodeMan.get(id, false)?.controller;
        if (c?.moveToFirst) { c.moveToFirst(); setTimeout(() => c.moveToFirst(), 0); }
    };
    leadSelector("cameraTrackSwitch");   // "Position" leads Location
    leadSelector("CameraLOSController");  // "Camera Heading" leads Heading
    leadSelector("fovSwitch");            // "Camera FOV" leads FOV (Zoom)

    // The Location/Heading/FOV (and Camera Tweaks) sub-folders are permanent shells,
    // but only the custom sitch populates them. Hide any that a sitch leaves empty
    // (e.g. gimbal/gofast) so they don't show as bare empty folders. Re-evaluated
    // each load; the deferred pass catches controls added on a setTimeout(0).
    const showFolderIfPopulated = (id) => {
        const f = guiMenus[id];
        if (!f) return;
        const hasContent = (f.controllers?.some(c => !c._hidden)) || (f.folders?.length > 0);
        hasContent ? f.show() : f.hide();
    };
    const updateCameraFolders = () =>
        ["cameraLocation", "cameraHeading", "cameraFOV", "cameraLens", "cameraTweaks"]
            .forEach(showFolderIfPopulated);
    updateCameraFolders();
    setTimeout(updateCameraFolders, 0);

    // Split-tree tiling (UI redesign Phase 2). A saved sitch may carry an explicit tiling tree
    // (Sit.layout, restored verbatim so seam positions persist); otherwise, if the open views
    // already form a complete snapped grid, auto-couple their shared edges. Both no-op on a
    // free-floating layout and are skipped in regression mode so the legacy-geometry baselines
    // stay deterministic. Edge-to-edge ⇒ no geometry change either way.
    if (!Globals.regression) {
        if (Sit.layout) {
            LayoutMan.setLayout(Sit.layout);
        } else {
            LayoutMan.autoTileIfSnapped();
        }
    }

///////////////////////////////////////////////////////////////////////////////////////////////
}

function startAnimating(fps) {
    startTime = performance.now();
    then = startTime;
    thenRender = startTime;
    console.log("STARTUP TIME = " + startTime/1000);
    // fpsInterval controls logic updates (based on video framerate)
    fpsInterval = 1000 / fps ;           // e.g. 1000/30 = 33.333333
    // rafInterval controls how often RAF does any work (from fpsLimit setting, defaults to 60)
    let rafFps = 60;
    if (Globals.settings && Globals.settings.fpsLimit) {
        rafFps = Globals.settings.fpsLimit;
    }
    rafInterval = 1000 / rafFps;
    scheduleAnimationLoop(16);
    setRenderOne(true);
}


function animate(newtime) {
    // Method of setting frame rate, from:
    // http://jsfiddle.net/chicagogrooves/nRpVD/2/
    // uses the sub-ms resolution timer window.performance.now() (a double)
    // and does nothing if the time has not elapsed

    const animateStartTime = window.performance.now();
    let logicRan = false;

    now = newtime;

    // No sitch is loaded yet: Sit is only assigned by setSit(). On the async
    // ?custom= load path setSit() runs after an `await fetch(...)`, and the
    // render-on-demand loop can be woken during that window (visibilitychange /
    // setRenderOne / par.frame), firing this setTimeout-scheduled animate() while
    // Sit is still undefined — which threw "Cannot read properties of undefined
    // (reading 'fps')" at `Sit.fps` below. Nothing to render yet, so bail out;
    // startAnimating() re-arms the loop once the sitch is established.
    if (Sit === undefined) {
        return;
    }

    // Update rafInterval based on current fpsLimit setting
    let rafFps = 60;
    if (Globals.settings && Globals.settings.fpsLimit) {
        rafFps = Globals.settings.fpsLimit;
    }
    rafInterval = 1000 / rafFps;

    if (shouldSleepAnimationLoop()) {
        return;
    }
    
    // Check if enough time has elapsed for RAF to do anything (fpsLimit gate)
    const elapsedSinceRender = now - thenRender;
    if (elapsedSinceRender < rafInterval) {
        // Not yet time, reschedule and return early
        scheduleAnimationLoop(rafInterval - elapsedSinceRender);
        return;
    }



    Globals.stats.begin();
   // infoDiv.innerHTML = "";

    // Update fpsInterval based on current video fps and fpsLimit setting
    // Also incorporate adaptive frame rate control
    let targetFps = Sit.fps;
    
    // Apply adaptive frame rate adjustment
    frameRateController.adjustFPS();
    const adaptiveFps = frameRateController.getCurrentFPS();
    
    if (Globals.settings && Globals.settings.fpsLimit) {
        targetFps = Math.min(Math.min(targetFps, adaptiveFps), Globals.settings.fpsLimit);
    } else {
        targetFps = Math.min(targetFps, adaptiveFps);
    }
    fpsInterval = 1000 / targetFps;

    const smoothFrameRate = false;

   // animationFrameId = requestAnimationFrame( animate );

    if (smoothFrameRate) {
        // elapsed = now - then;
        // renderMain(elapsed);
        // then = now;
        // // Record frame time (all frames have logic in smooth mode)
        // if (thenRender > 0) {
        //     const frameTime = now - thenRender;
        //     frameRateController.recordFrameTime(frameTime, true);
        // }
    } else {
        // Check time since last logic update
        elapsed = now - then;
        
        // if enough time has elapsed, draw the next frame
        if (elapsed >= fpsInterval) {

            // if (!par.paused)
            // debugLog("Newtime = " + newtime + " ms" + "Elapsed = " + elapsed + " ms" + " fpsInterval = " + fpsInterval + " fps = " + Sit.fps + " frame = " + par.frame)

            // we need to account for full frames and fractions of frames
            // so first calculate the fraction of a frame that has elapsed
            const remainder = elapsed % fpsInterval;
            // and reset the "then" time to the current time minus the remainder
            then = now - remainder;
            // and execute logic for a whole number of frames (usually 1)
            renderMain(elapsed - remainder);
            logicRan = true;
        } else {
            // It is not yet time for a new frame
            // so just render - which will allow smooth motion between logic updates
            // const oldPaused = par.paused
            //par.paused = true;
            par.noLogic = true;
            renderMain(0); // 0 so we don't advance anything between frames
            par.noLogic = false;
            //par.paused = oldPaused;
            logicRan = false;
        }

    }
    Globals.stats.end();
    
    // GPU queue backlog prevention: flush GPU command buffers and check for saturation
    flushGPUAndCheckBacklog();

    // Update render timer
    thenRender = now;
    
    // Schedule next RAF call (runs frequently, but does nothing until rafInterval elapses)
    scheduleAnimationLoop(0);


    // finally we check the time taken to run the frame
    // which we use to adapt the frame rat
    if (logicRan) {
        // Record frame time for adaptive FPS control (only if logic ran)
        if (thenRender > 0) {
            const frameTime = window.performance.now() - animateStartTime;
            frameRateController.recordFrameTime(frameTime);
        }
    }


}

// Mark Sitrec as fully ready — exposes Sit to window and updates the DOM
// ready signal used by Puppeteer tests and the MCP bridge extension.
// Called after setSit() in all sitch loading paths (built-in and custom).
function markSitrecReady() {
    if (typeof window === 'undefined') return;
    window.Sit = Sit;

    if (window.SITREC_OBJECTS_READY) {
        window.SITREC_OBJECTS_READY.Sit = true;
        window.SITREC_OBJECTS_READY.allReady = true;
        window.SITREC_OBJECTS_READY.timestamp = Date.now();
    } else {
        window.SITREC_OBJECTS_READY = {
            NodeMan: !!window.NodeMan,
            DragDropHandler: !!window.DragDropHandler,
            Sit: true,
            allReady: true,
            timestamp: Date.now()
        };
    }

    const readyElement = document.getElementById('sitrec-objects-ready');
    if (readyElement) {
        readyElement.setAttribute('data-ready', 'complete');
        readyElement.setAttribute('data-timestamp', Date.now().toString());
    } else {
        const newReadyElement = document.createElement('div');
        newReadyElement.id = 'sitrec-objects-ready';
        newReadyElement.setAttribute('data-ready', 'complete');
        newReadyElement.setAttribute('data-timestamp', Date.now().toString());
        newReadyElement.style.display = 'none';
        document.body.appendChild(newReadyElement);
    }
}

function loadStartupDropURLAfterSitchSetup() {
    if (startupDropURLLoaded) return;

    const dropURL = urlParams?.get("drop")?.trim();
    if (!dropURL) return;

    startupDropURLLoaded = true;
    console.log("Loading URL from drop= parameter after sitch setup: " + dropURL);
    setTimeout(() => {
        DragDropHandler.uploadURL(dropURL, {persistDrop: false}).catch(error => {
            console.warn("Failed to load startup drop URL:", error);
        });
    }, 0);
}

function selectInitialSitch(force) {

    if (force) {
        situation = force;
    } else {




        if (urlParams.get("test")) {
            // get the list of situations to test
            toTest = urlParams.get("test")
            testing = true;
        }

// A smoke test of all situations, so we generate the list
// which then gets passed as a URL, as above.
        if (urlParams.get("testAll")) {
            toTest = ""
            for (const key in sortedSitches) {
             //   if (sortedSitches[key] !== "testall" && sortedSitches[key] !== "testquick" && sortedSitches[key] !== "testhere")
                if (SitchMan.exists(sortedSitches[key])) {
                    toTest += sortedSitches[key] + ",";
                }
            }
            toTest += localSituation; // end up with the current situation being tested
            testing = true;

            console.log(urlParams.get("testAll"));
            const testType = urlParams.get("testAll")
            if (testType === "2")
                Globals.quickTerrain = true;

        }

// toTest is a comma separated list of situations to test
// if it is set, we will test the first one, then the rest
// will be tested in order.
        if (toTest !== undefined) {
            const testArray = toTest.split(',');
            situation = testArray.shift() // remove the first (gimbal)
            toTest = testArray.join(",")
            console.log("Testing " + situation + ", will text next: " + toTest)
        }

// Either "sit" (deprecated) or "sitch" can be used to specify a situation in the url params
        if (urlParams.get("sit")) {
            situation = urlParams.get("sit")
        }
        if (urlParams.get("sitch")) {
            situation = urlParams.get("sitch")
        }
    }

// situation is a global variable that is used to determine which situation to load
// It's a string, and it's case insensitive.
// We use the lower case version of the string to determine which situation to load
// and the original string to display in the GUI.
// This allows for variants like FLIR1/Tictac
// to test for a particular situation, use Sit.name
// slice
    const lower = situation.slice().toLowerCase();

    if (lower === "testall") {
        const url = SITREC_APP + "?testAll=1"
        window.location.assign(url)
        return;
    }
    if (lower === "testquick") {
        const url = SITREC_APP + "?testAll=2"
        window.location.assign(url)
        return;
    }

    par.name = lower;

    let startSitch = SitchMan.findFirstData(s => {return lower === s.data.name;})
    assert(startSitch !== null, "Can't find startup Sitch: "+lower)

    console.log("");
    console.log("NEW Situation = "+situation)
    console.log("");

    setSit(new CSituation(startSitch))
    markSitrecReady();
}


function disposeEverything() {
    console.log("");
    console.log(" >>>>>>>>>>>>>>>>>>>>>>>> disposeEverything() <<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<<");
    console.log("");

    Globals.disposing = true;

    // cancel any requested animation frames
    clearScheduledAnimation();

    // Remove all event listeners
    EventManager.removeAll();

    // specific to the gimbal chart, but no harm in calling it here in case it gets used in other situations
    disposeGimbalChart();

    // stop loading terrain
    imageQueueManager.dispose();

    // The measurement UI is a group node that holds all the measurement arrows
    // it's created as needed, but will get destroyed with the scene
    // so we need to make sure it knows it's been destroyed
    removeMeasurementUI();


    // dispose the track manager managed nodes
    TrackManager.disposeAll();

    // delete all the nodes (which should remove their GUI elements, but might not have implement that all. CNodeSwitch destroys)
    NodeMan.disposeAll();

    // dispose of any feature manager managed nodes
    FeatureManager.disposeAll();

    // dispose custom graphs (folders) and clear the per-frame data-series registry
    CustomGraphManager.disposeAll();
    GraphDataManager.disposeAll();

    // reset motion analysis state (must be after NodeMan.disposeAll since it references the video node)
    resetMotionAnalysis();
    resetObjectTracking();
    resetHorizonExtractor();
    // Star Tracker holds a solve tied to the old video, plus a GUI folder the menu bar is about
    // to destroy; both must go or the result draws over the next sitch's video and the menu
    // never rebuilds.
    disposeStarTracker();
    // camera motion data is per-video; clear so the next sitch reloads its own cache
    Globals.cameraMotionData = undefined;
    Globals.cameraMotionRaw = undefined;

    // dispose of any remaining GUI, except for the permanent folders and items
    Globals.menuBar.destroy(false);

    disposeDebugArrows();
    disposeDebugSpheres();

    console.log("GlobalScene originally has " + GlobalScene.children.length + " children");
    disposeScene(GlobalScene)
    console.log("GlobalScene now (after dispose) has " + GlobalScene.children.length + " children");
    if (GlobalNightSkyScene !== undefined) {
        disposeScene(GlobalNightSkyScene)
        setupNightSkyScene(undefined)
    }
    if (GlobalDaySkyScene !== undefined) {
        disposeScene(GlobalDaySkyScene)
        setupDaySkyScene(undefined)
    }
    if (GlobalSunSkyScene !== undefined) {
        disposeScene(GlobalSunSkyScene)
        setupSunSkyScene(undefined)
    }

    // dispose of the renderers attached to the views
    ViewMan.iterate((key, view) => {
        view.renderer.renderLists.dispose();
    });

    // add the local frame back to the global scene
    GlobalScene.add(LocalFrame)

    // unload all assets - which we might not want to do if just restarting
    FileManager.disposeAll()


    // clear the material cache
    QuadTreeTile.clearMaterialCache();

    // ensure the next sitch has a good default value (false) for Globals.dynamicSubdivision
    Globals.dynamicSubdivision = false;

    // A custom-sitch deserialize sets dontAutoZoom=true for its file-load phase and
    // deserializing=true for its whole span, clearing both when it completes — but
    // its continuations deliberately abort WITHOUT touching either flag when their
    // load was superseded (stale-load guards in CustomManagerSerialize). Reset both
    // here: an in-flight deserialize is dead the moment we tear down for a new
    // sitch, and a leaked flag would suppress auto-centering / keep the app in
    // "deserializing" state for the next sitch.
    Globals.dontAutoZoom = false;
    Globals.deserializing = false;
    // dontRecalculate is set true for the mods pass and cleared only by a
    // SUCCESSFUL finishDeserialization — a stale-aborted load would leak it and
    // leave recalculation disabled for the next sitch.
    Globals.dontRecalculate = false;

    // Clear any fullscreen/double-click zoom state so new sitch views are all visible
    ViewMan.setFullscreenView(null);

    // Bump the load generation so any async work still in flight from the
    // sitch we're tearing down (asset fetches resolving late, or the deferred
    // mod-deserialize loop parked on waitForPendingActions) detects it has been
    // superseded and bails instead of writing its state onto the next sitch.
    // This is the fix for the "load A, switch to B before A finishes" race that
    // left the new sitch with a stale doubled/fullscreen view (black look/video
    // views) and a half-applied graph.
    Globals.loadGeneration++;

   // ViewMan.disposeAll()
    assert(ViewMan.size() === 0, "ViewMan.size() should be zero, it's " + ViewMan.size());
    console.log("disposeEverything() is finished");
    console.log("");

    Globals.disposing = false;
}

/**
 * Waits until all terrain images are loaded.
 * same as above, maybe refactor at some point
 * except this is a flag, and that is a counter
 * but a truthy test works for both
 */
async function waitForTerrainToLoad() {
    console.log("Waiting for terrain loading to complete... Globals.loadingTerrain = " + Globals.loadingTerrain);
    // Use a Promise to wait
    await new Promise((resolve, reject) => {
        // Function to check the value of Globals.parsing
        function checkloadingTerrain() {
            if (!Globals.loadingTerrain) {
                console.log("DONE: Globals.loadingTerrain = " + Globals.loadingTerrain)
                resolve(); // Resolve the promise if Globals.parsing is 0 (or false)
            } else {
                // If not 0, wait a bit and then check again
                setTimeout(checkloadingTerrain, 100); // Check every 100ms, adjust as needed
                console.log("Still Checking, Globals.loadingTerrain = " + Globals.loadingTerrain)
            }
        }

        // Start checking
        checkloadingTerrain();
    });
    console.log("loadingTerrain complete!");
}
