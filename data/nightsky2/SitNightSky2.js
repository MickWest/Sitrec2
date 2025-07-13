export const SitNightSky2 = {
    include_custom: true,
    name: "nightsky2",
    menuName: "Starlink Horizon Flares",
    showFlareBand: true,
    showSunArrows: true,
    isTool: true, // we need this here even thought it is in SitCustom.js, as it's checked before merging SitCustom.js
    isRoot: true,
    isCustom: true, // same as above, we need this here

    patchSatellites: true, // this is a custom patch to the satellites, normally programattically done in SitNightSky.js

    fps: 30,
    frames: 3000, // 100 seconds at 30 fps
    startTime: "current",

  //  localLatLon: true,


}
