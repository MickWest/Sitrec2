export const SitStarlink = {

    // // this line is needed to include the SitCustom.js file
     include_custom: true,
    //
    // // the following stuff all overrides the SitCustom.js file settings
    // // spcifically for the Starlink Horizon Flares simulation
    //
     name: "starlink",
     menuName: "Starlink Horizon Flares",
    showFlareBand: true,
    showSunArrows: true,
    isTool: true, // we need this here even thought it is in SitCustom.js, as it's checked before merging SitCustom.js
    isRoot: true,
    isCustom: true, // same as above, we need this here

    patchSatellites: true, // this is a custom patch to the satellites, normally programattically done in SitNightSky.js
    //
     fps: 30,
     frames: 3000, // 100 seconds at 30 fps
     bFrame: 3000,
     startTime: "current",
    //
    //localLatLon: true,

    nightSky: {
        starLink: "starLink",
        showConstellations: true,
        showEquatorialGrid: true,
        showEquatorialGridLook: true,
    },

    // this is the same as in SitCustom.js, but with el set to 10
    ptzAngles: {kind: "PTZUI", az: 0, el: 10, roll: 0, fov: 30, showGUI: true, gui: "camera"},


}
