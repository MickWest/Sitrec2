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
        dbg_renderSunSky: true
    }
}

export function setGPUMemoryMonitor(monitor) {
    Globals.GPUMemoryMonitor = monitor;
}

export function setSitchEstablished(bool) {
    Globals.sitchEstablished = bool;
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
    return guiMenus[id];
}

// ad a folder to a menu
export function addGUIFolder(id, title, parent) {
    guiMenus[id] = guiMenus[parent].addFolder(title).close().perm();
    return guiMenus[id];
}

export function setupGUIjetTweaks(_jetTweaks) {
    guiJetTweaks = _jetTweaks
}

export function setRenderOne(value=true) {
    if (!par.renderOne) {
        par.renderOne = value;
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