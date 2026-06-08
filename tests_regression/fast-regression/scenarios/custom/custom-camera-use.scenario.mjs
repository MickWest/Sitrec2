// M1 — USING a custom sitch: navigate the camera via the same API the UI drives, and read
// the position back. gotoLLA moves the observer; setCameraAltitude changes height. getCameraLLA
// reads the camera's _LLA. Asserts the navigation actually took effect and is reproducible.
//
// isolated:true — gotoLLA/setCameraAltitude are mutating drives on a fresh, never-saved page.
export default {
    id: 'custom-camera-use',
    sitch: 'custom',
    builtin: true,
    frame: 10,
    tier: 'value',
    network: 'none',
    isolated: true,
    steps: [
        // Where the camera starts on a fresh custom sitch (baseline of the default view point).
        {type: 'capture', name: 'cameraStart', read: {api: 'getCameraLLA'}},
        // Navigate to a fixed point (central London) at 5 km.
        {type: 'apiCall', fn: 'gotoLLA', args: {lat: 51.5, lon: -0.13, alt: 5000}},
        {type: 'capture', name: 'cameraAfterGoto', read: {api: 'getCameraLLA'}},
        // Raise altitude only — lat/lon should hold, alt should become 12 km.
        {type: 'apiCall', fn: 'setCameraAltitude', args: {alt: 12000}},
        {type: 'capture', name: 'cameraAfterAlt', read: {api: 'getCameraLLA'}},
    ],
};
