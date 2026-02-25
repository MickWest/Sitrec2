
export const SitDume = {
    name: "dume",
    menuName: "Pt Dume -> Mt Jacinto",
    animated:false,
    isTextable: true,

    fps: 30,
    frames: 100,

    terrain: {lat:  34.001856, lon:-118.806196, zoom:9, nTiles:8},
    flattening: true,

    mainCamera: {
        startCameraPositionLLA:[34.005276,-118.863148,1078.535159],
        startCameraTargetLLA:[34.005919,-118.852541,887.903708],
    },
    mainView: {left: 0.0, top: 0, width: 0.5, height: 1,fov:50,background: [0.53, 0.81, 0.92]},

    lookCamera: {fov: 10,},
    lookView: {left: 0.5, top: 0, width: 0.5, height: 1,fov: 50, background: [0.53, 0.81, 0.92]},

    cameraTrack: {LLA: [34.001241, -118.806459, 140]},
    followTrack: {}, // will default to lookCamera and cameraTrack
    ptz: {az: 96.4, el: -0.3, fov: 4, showGUI: true},

}
