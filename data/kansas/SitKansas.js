export const SitKansas = {
    include_kml: true,
    name: "kansas",
    menuName: "Kansas Tic-Tac",
    isTextable: true,
    targetSize: 200, // in feet
    frames: 569,

    terrain: {lat: 38.890803, lon: -101.874630, zoom: 9, nTiles: 8},
    files: {
        cameraFile:   'kansas/N615UX-track-EGM96.kml',
        TargetTrack: 'kansas/N121DZ-track-EGM96.kml',
        TargetObjectFile: './models/B737Max8.glb',
    },
    startTime: "2022-09-01T20:07:32.3Z",

    videoFile: "../sitrec-videos/private/124984_Kansas.mp4",
    skyColor: 'skyblue',

    videoView: { left: 0.5, top: 0.1, width: 0.25, height: -1.77777777,},
    lookView: { left: 0.75, top: 0.1, width: 0.25, height: -1.77777777,},

    mainCamera: {
        startCameraPositionLLA:[38.720841,-102.293823,19298.461877],
        startCameraTargetLLA:[38.727979,-102.287889,18985.795981],
    },
    lookCamera:{ fov: 22.25},
    cameraTrack: {},

    mainView:{left:0.0, top:0, width:0.50,height:1},
    tilt: 4.63,

    include_TrackToTrack: true,
//    targetSizedSphere: { size:200 },

  //  targetObject: {file: "TargetObjectFile"},


    targetObject: { kind: "3DObject",
        geometry: "box",
        layers: "TARGETRENDER",
        size: 1,
        radius: 10,

        width: 3,
        height: 4,
        depth: 10,

        material: "lambert",
        color: "#FFFFFF",
        emissive: '#404040',
        widthSegments:20,
        heightSegments:20,
    },
    moveTargetAlongPath: {kind: "TrackPosition", object: "targetObject", sourceTrack: "targetTrack"},
//    orientTarget: {kind: "ObjectTilt", object: "targetObject", track: "LOSTraverseSelectTrack", tiltType: "banking"},
    orientTarget: {kind: "ObjectTilt", object: "targetObject", track: "targetTrack"},


   // displayLOS: {kind: "DisplayLOS", LOS: "JetLOS", color: "red", width: 1.0},



}