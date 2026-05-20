import {getTranslationVariants, t} from "./i18n";
import {par} from "./par";

export let mainLoopCount = 0;
export function incrementMainLoopCount() {
    mainLoopCount++
//    console.log("Incrementing mainLoopCount to " + mainLoopCount);
};

export const Globals = {
    // Earth model radii — updated by updateEarthRadii() in LLA-ECEF-ENU.js.
    // Both default to wgs84.RADIUS so legacy code is unaffected until a sitch loads.
    // useEllipsoid=false → both equal wgs84.RADIUS (degenerate sphere).
    // useEllipsoid=true  → equatorRadius=wgs84.RADIUS, polarRadius=wgs84.POLAR_RADIUS.
    equatorRadius: 6378137,   // wgs84.RADIUS
    polarRadius:   6378137,   // starts as sphere; set to wgs84.POLAR_RADIUS when useEllipsoid

    editingTrack: null,  // Reference to the CMetaTrack currently being edited
    editingBuilding: null,  // Reference to the CNodeSynthBuilding currently being edited
    editingClouds: null,  // Reference to the CNodeSynthClouds currently being edited
    justVideoAnalysis: false,  // When true, skip most logic and only render video viewport
    GPUMemoryMonitor: null,  // GPU Memory Monitor instance
    debugGPUBacklog: false,  // Enable logging of GPU buffer flushes
    showTileStats: false,  // Enable tile statistics logging
    showCompassElevation: false, // Show elevation on compass
    isMobile: false, // Is device a mobile/touchscreen device
    arMode: false, // AR mode active (camera follows device orientation)
    tileDelay: 0,  // Additional delay before loading tiles (0-5 seconds)
    screenshotting: false, // true during batch screenshot generation (skips menu rebuilds)
    disposing: false, // true during disposeEverything() to suppress side-effects
    testUserID: 0, // Admin-only: operate as this user ID when > 1
    sitchDirty: false, // true when user has made meaningful changes (not just camera/frame)
    hasByokKeys: false, // true when the user has at least one BYOK LLM API key stored in IndexedDB
    useVideoPatching: true, // wrap dropped-frame video with CVideoPatchedData (see docs/dev/misb-timing.md)

    // V5 OBB tile-culling flags (Phase 0.1.a). Pure data, no behavior change
    // yet — calculateTileVisibility hasn't been refactored to consult these.
    // Defaults to "legacy" until measured-bounds pipeline (Phase 1+) and
    // sphere/obb modes (Phase 2+/3) ship.
    tileBoundsMode: { mainView: "legacy", lookView: "legacy" },
    enableReachCull: true,
    tileCullBudgetMs: 4,
    showTileOBB: false,

    // Granular render debug flags - shared across ALL views
    renderDebugFlags: {
        dbg_clearBackground: true,
        dbg_renderSky: true,
        dbg_renderDaySky: true,
        dbg_renderMainScene: true,
        dbg_renderEffects: true,
        dbg_copyToScreen: true,
        dbg_updateCameraMatrices: true,
        dbg_mainViewUseLookLayers: false,
        // Granular renderSky() step flags
        dbg_updateStarScales: true,
        dbg_updateSatelliteScales: true,
        dbg_renderNightSky: true,
        dbg_renderFullscreenQuad: true,
        dbg_renderSunSky: true,
        dbg_sRGBOutputEncoding: true,
    }
}

export function setGPUMemoryMonitor(monitor) {
    Globals.GPUMemoryMonitor = monitor;
}

// Returns the user's render-scale multiplier from settings, clamped to [0.25, 1].
// Used to scale both the renderer pixel ratio and the offscreen render target
// dimensions, giving a single knob for hi-DPI / slow-GPU users to trade visual
// fidelity for fps. Returns 1 when settings are not yet initialised.
export function getEffectiveRenderScale() {
    const rs = Globals.settings && Globals.settings.renderScale;
    if (typeof rs !== 'number' || !isFinite(rs)) return 1;
    return Math.max(0.25, Math.min(1, rs));
}

// Returns the configured MSAA sample count for offscreen render targets.
// 0 disables multisampling. Default is 4 to preserve previous behaviour when
// settings are absent.
export function getEffectiveMSAASamples() {
    const s = Globals.settings && Globals.settings.msaaSamples;
    if (typeof s !== 'number' || !isFinite(s)) return 4;
    if (s <= 0) return 0;
    return Math.max(0, Math.min(8, Math.round(s)));
}

export function setSitchEstablished(bool) {
    Globals.sitchEstablished = bool;
}

// --- V5 OBB tile-culling stats (Phase 0.1.a) ---
// One bag per view; counters bump from the subdivide pass (Phase 0.1.b
// onward). activeTileHash is an FNV-1a digest of the set of active z/x/y
// triples, used by MCP procedures to assert tile-set stability across mode
// flips. reset() zeros every numeric field for A/B comparison. The
// `tileCullStats` object on Globals is mirrored to
// window.__sitrecTileCullStats for MCP `sitrec_eval` access.
function makeTileCullStatsBag() {
    return {
        sphereRejected: 0,
        obbRejectedDilated: 0,
        obbRejectedStrict: 0,
        reachRejected: 0,
        unmeasuredBoundsUsed: 0,
        inheritedBoundsUsed: 0,
        elevationDataBoundsUsed: 0,
        renderedBoundsUsed: 0,
        visCacheHits: 0,
        visCacheMisses: 0,
        polarFallbackUsed: 0,
        activeTerrainMeshes: 0,
        activeTileHash: 0,
        cullSelfTimeMs: 0,
        inStrictFrustum: 0,
        inDilatedMargin: 0,
        cameraInsideSphere: 0,
        horizonOccluded: 0,
        outOfFrustum: 0,
        forcedRoot: 0,
        subdivided: 0,
        merged: 0,
    };
}

Globals.tileCullStats = {
    mainView: makeTileCullStatsBag(),
    lookView: makeTileCullStatsBag(),
    reset() {
        for (const view of ["mainView", "lookView"]) {
            const bag = this[view];
            for (const k of Object.keys(bag)) if (typeof bag[k] === "number") bag[k] = 0;
        }
    },
};

if (typeof window !== "undefined") {
    window.__sitrecTileCullStats = Globals.tileCullStats;
}

// FNV-1a 32-bit hash of the active z/x/y triples for a layer mask. Same
// digest formula used by Playwright fixtures and MCP procedures.
export function computeActiveTileHash(allTiles, layerMask) {
    let h = 0x811c9dc5;
    const tiles = [];
    for (const t of allTiles) {
        if ((t.tileLayers || 0) & layerMask) {
            tiles.push((t.z << 24) ^ (t.x << 12) ^ t.y);
        }
    }
    tiles.sort((a, b) => a - b);
    for (const v of tiles) {
        h ^= v;
        h = Math.imul(h, 0x01000193) | 0;
    }
    return h >>> 0;
}

// URL parsing for `?tileBoundsMode=obb`, `?tileBoundsModeMain=sphere`,
// `?tileBoundsModeLook=legacy`, `?enableReachCull=0|1`. Called from index.js
// during boot so the first subdivide pass sees the requested mode.
const TILE_BOUNDS_MODES = new Set(["legacy", "metrics", "sphere", "obb"]);
export function applyTileBoundsModeFromUrl() {
    if (typeof location === "undefined") return;
    const params = new URLSearchParams(location.search);
    const both = params.get("tileBoundsMode");
    if (both && TILE_BOUNDS_MODES.has(both)) {
        Globals.tileBoundsMode.mainView = both;
        Globals.tileBoundsMode.lookView = both;
    }
    const main = params.get("tileBoundsModeMain");
    if (main && TILE_BOUNDS_MODES.has(main)) Globals.tileBoundsMode.mainView = main;
    const look = params.get("tileBoundsModeLook");
    if (look && TILE_BOUNDS_MODES.has(look)) Globals.tileBoundsMode.lookView = look;
    const reach = params.get("enableReachCull");
    if (reach === "0" || reach === "false") Globals.enableReachCull = false;
    else if (reach === "1" || reach === "true") Globals.enableReachCull = true;
}

// Map a view id to the per-view tile-bounds mode. Coerces unknown views to
// "legacy" so a typo never silently disables culling.
export function tileBoundsModeForView(viewId) {
    const mode = Globals.tileBoundsMode?.[viewId];
    return TILE_BOUNDS_MODES.has(mode) ? mode : "legacy";
}

// Returns testUserID if set by admin, otherwise real userID
export function getEffectiveUserID() {
    if (Globals.testUserID > 1) return Globals.testUserID;
    return Globals.userID;
}

// Append testUserID param to a server URL when testUserID > 1
// Server validates that the real user is admin before honoring it
export function withTestUser(url) {
    if (Globals.testUserID > 1) {
        const separator = url.includes('?') ? '&' : '?';
        return url + separator + 'testUserID=' + Globals.testUserID;
    }
    return url;
}

export let Sit;
export function setSit(s) {Sit = s;}

export let NodeMan;
export function setNodeMan(n) {NodeMan = n;}

export let NodeFactory;
export function setNodeFactory(n) {NodeFactory = n;}

export let TrackManager;
export function setTrackManager(tm) {TrackManager = tm;}


export let NullNode;
export function setNullNode(n) {NullNode = n;}

export let SitchMan;
export function setSitchMan(n) {SitchMan = n;}

export let CustomManager;
export function setCustomManager(n) {CustomManager = n;}

export let Synth3DManager;
export function setSynth3DManager(n) {Synth3DManager = n;}

export let UndoManager;
export function setUndoManager(n) {UndoManager = n;}

export let gui;
export let guiTweaks;
export let guiShowHide;
export let guiJetTweaks;
export let guiShowHideViews
export let guiShowHideGraphs
export let guiPhysics;


export let infoDiv;
export function setInfoDiv(i) {infoDiv=i;}

export let GlobalComposer;
export function setComposer(i) {GlobalComposer=i;}

export let GlobalURLParams;
export function setGlobalURLParams(i) {GlobalURLParams=i;}

export let GlobalDateTimeNode;
export function setGlobalDateTimeNode(i) {GlobalDateTimeNode=i;}

export function setNewSitchObject(object){
    Globals.newSitchObject = object;
}

export function markSitchDirty() {
    // Suppress during initialization and deserialization
    if (Globals.deserializing || Globals.disposing) return;
    Globals.sitchDirty = true;
}

export const guiMenus = {}

export function setupGUIGlobals(_gui, _show, _tweaks, _showViews, _showGraphs, _physics) {
    gui = _gui
    guiShowHide = _show;
    guiTweaks = _tweaks;
    guiShowHideViews = _showViews;
    guiShowHideGraphs = _showGraphs;
    guiPhysics = _physics;
}

// add to the menubar
export function addGUIMenu(id, title) {
    guiMenus[id] = Globals.menuBar.addFolder(title).close().perm();
    guiMenus[id]._menuId = id;
    return guiMenus[id];
}

export function addTranslatedGUIMenu(id, titleKey) {
    const gui = addGUIMenu(id, t(titleKey));
    gui._serializationAliases = getTranslationVariants(titleKey);
    return gui;
}

// ad a folder to a menu
export function addGUIFolder(id, title, parent) {
    const parentMenu = guiMenus[parent];
    const existing = guiMenus[id];
    // Catch the bug where a permanent folder is created a second time:
    // menuBar.destroy(false) keeps permanent folders but destroys their
    // non-permanent children, so a duplicate addGUIFolder leaves the empty
    // husk behind and adds a new folder beside it. Permanent folders must
    // be created once at app init, not from per-sitch setup paths.
    // Inline assert (Globals can't import ./assert without a circular dep).
    if (existing && parentMenu && parentMenu.folders && parentMenu.folders.includes(existing)) {
        console.trace();
        console.error(`ASSERT: addGUIFolder("${id}") called twice — folder already exists under "${parent}"`);
        if (!Globals.validationMode) debugger;
    }
    guiMenus[id] = parentMenu.addFolder(title).close().perm();
    return guiMenus[id];
}

export function addTranslatedGUIFolder(id, titleKey, parent) {
    return addGUIFolder(id, t(titleKey), parent);
}

export function setupGUIjetTweaks(_jetTweaks) {
    guiJetTweaks = _jetTweaks
}

export function setRenderOne(value=true) {
    if (!par.renderOne) {
        par.renderOne = value;
        globalThis.__sitrecWakeRenderLoop?.();
    }
}


// the curvature of the earth WAS adjusted for refraction using the standard 7/6R
// This is because the pressure gradient bends light down (towards lower, denser air)
// and so curves the light path around the horizon slightly, making the Earth
// seem bigger, and hence with a shallower curve
//export const EarthRadiusMiles = 3963 * 7 / 6
export const EarthRadiusMiles = 3963.190592  // exact wgs84.RADIUS
export let Units;
export function setUnits(u) {Units = u;}

export let FileManager;
export function setFileManager(f) {FileManager = f;}

export const keyHeld = {}
export const keyCodeHeld = {}

// Frame advance blockers - callbacks that can prevent frame advancement
// Each callback receives (currentFrame, nextFrame) and returns true to block
const frameAdvanceBlockers = new Map();

export function registerFrameBlocker(id, callback) {
    frameAdvanceBlockers.set(id, callback);
}

export function unregisterFrameBlocker(id) {
    frameAdvanceBlockers.delete(id);
}

export function isFrameAdvanceBlocked(currentFrame, nextFrame) {
    for (const [id, blocker] of frameAdvanceBlockers) {
        const result = blocker.check(currentFrame, nextFrame);
        if (result) {
            if (blocker.onBlocked) {
                blocker.onBlocked(currentFrame, nextFrame);
            }
            return true;
        }
    }
    return false;
}

export function requiresSingleFrameMode() {
    for (const [id, blocker] of frameAdvanceBlockers) {
        if (blocker.requiresSingleFrame && blocker.requiresSingleFrame()) {
            return true;
        }
    }
    return false;
}

// Track if mouse is over a GUI element (to disable keyboard shortcuts)
export let mouseOverGUI = false;
export function setMouseOverGUI(value) { mouseOverGUI = value; }

// Helper function to access the debug view
export function getDebugView() {
    if (NodeMan && NodeMan.exists("debugView")) {
        return NodeMan.get("debugView");
    }
    return null;
}

// Global debug logging function
export function debugLog(text) {
    const debugView = getDebugView();
    if (debugView) {
        debugView.log(text);
    } else {
      //  console.log("Debug:", text);
    }
}
