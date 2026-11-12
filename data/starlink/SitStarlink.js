export const SitStarlink = {

    // // this line is needed to include the SitCustom.js file
     include_custom: true,
    //
    // // the following stuff all overrides the SitCustom.js file settings
    // // spcifically for the Starlink Horizon Flares simulation
    //
     name: "starlink",
     menuName: "Starlink Horizon Flares (LIVE)",
    showFlareBand: true,
    showSunArrows: true,
    isTool: true, // we need this here even thought it is in SitCustom.js, as it's checked before merging SitCustom.js
    isRoot: true,
    isCustom: true,  // same as above, we need this here
    startLive: true, // start in permanent live mode. User can exit this by dragging the time



    // Don't need to old terrain model any more
    // TerrainModel: {kind: "Terrain", lat: 34, lon: -118.3, zoom: 7, nTiles: 3, fullUI: true, dynamic: false},


    patchSatellites: "active", // Start with all current active satellites, including Starlink.
    //
     fps: 30,
     frames: 3000, // 100 seconds at 30 fps
     bFrame: 3000,
     startTime: "current",
    //
    //

    localLatLon: true,

    nightSky: {
        starLink: "starLink",
        showOtherSatellites: true,
        showConstellations: true,
        showEquatorialGrid: false,
        showEquatorialGridLook: false,
        showHorizonCompassRibbonLook: true,
    },

    // Satellite Controls start visible, and set the initial sky layout. The custom view
    // effects and any saved view positions stay. CCustomManager.setup() makes the panel.
    showSatelliteControls: true,
    startSkyLayout: true,
    fovUI: {kind: "GUIValue", value: 50, start: 0, end: 180, step: 0.001,
        desc: "vFOV", gui: "cameraFOV", hidden: true,
        tooltip: "Stored vertical field of view, in degrees, for the Manual Camera FOV source. Set it with VFOV (deg)."},
    // this is the same as in SitCustom.js, but with el set to 10
    ptzAngles: {kind: "PTZUI", az: 0, el: 10, roll: 0, fov: 50, showGUI: true, gui: "cameraHeading"},


}
