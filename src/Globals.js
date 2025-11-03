export let mainLoopCount = 0;
export function incrementMainLoopCount() {
    mainLoopCount++
//    console.log("Incrementing mainLoopCount to " + mainLoopCount);
};

export var Globals = {
    editingTrack: null,  // Reference to the CMetaTrack currently being edited
    editingBuilding: null,  // Reference to the CNodeSynthBuilding currently being edited
    GPUMemoryMonitor: null,  // GPU Memory Monitor instance
    debugGPUBacklog: false,  // Enable logging of GPU buffer flushes
    showTileStats: false,  // Enable tile statistics logging
    showCompassElevation: false, // Show elevation on compass
    
    // Granular render debug flags - shared across ALL views
    renderDebugFlags: {
        dbg_clearBackground: true,
        dbg_renderSky: true,
        dbg_renderDaySky: true,
        dbg_renderMainScene: true,
        dbg_renderEffects: true,
        dbg_copyToScreen: true,
        dbg_updateCameraMatrices: true,
        // Granular renderSky() step flags
        dbg_updateStarScales: true,
        dbg_updateSatelliteScales: true,
        dbg_updateSatelliteText: true,
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

export var Sit;
export function setSit(s) {Sit = s;}

export var NodeMan;
export function setNodeMan(n) {NodeMan = n;}

export var NodeFactory;
export function setNodeFactory(n) {NodeFactory = n;}


export var NullNode;
export function setNullNode(n) {NullNode = n;}

export var SitchMan;
export function setSitchMan(n) {SitchMan = n;}

export var CustomManager;
export function setCustomManager(n) {CustomManager = n;}

export var Synth3DManager;
export function setSynth3DManager(n) {Synth3DManager = n;}

export var UndoManager;
export function setUndoManager(n) {UndoManager = n;}

export var gui;
export var guiTweaks;
export var guiShowHide;
export var guiJetTweaks;
export var guiShowHideViews
export var guiPhysics;

export var infoDiv;
export function setInfoDiv(i) {infoDiv=i;}

export var GlobalComposer;
export function setComposer(i) {GlobalComposer=i;}

export var GlobalURLParams;
export function setGlobalURLParams(i) {GlobalURLParams=i;}

export var GlobalDateTimeNode;
export function setGlobalDateTimeNode(i) {GlobalDateTimeNode=i;}

export function setNewSitchObject(object){
    Globals.newSitchObject = object;
}

export const guiMenus = {}

export function setupGUIGlobals(_gui, _show, _tweaks, _showViews, _physics) {
    gui = _gui
    guiShowHide = _show;
    guiTweaks = _tweaks;
    guiShowHideViews = _showViews;
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
export var Units;
export function setUnits(u) {Units = u;}

export var FileManager;
export function setFileManager(f) {FileManager = f;}

export var keyHeld = {}
export var keyCodeHeld = {}

// Track if mouse is over a GUI element (to disable keyboard shortcuts)
export var mouseOverGUI = false;
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