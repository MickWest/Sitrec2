// The par structure holds global variables that need to be modified by the GUI
// It's a bit of a mess, but it's a convenient way to get the GUI variables into the code
// I consider it deprecated

export const par = {}
globalThis.par = par;


const parDefaults = {
    el: -2,
    az: -54,
    jetPitch: 3.6,
    jetRoll: 0,

    time: 0,

    _frame: 0,
    _frameOverride: undefined,
    _paused: false,

    get frame() {
        return this._frameOverride !== undefined ? this._frameOverride : this._frame;
    },
    set frame(value) {
        this._frame = value;
        this.renderOne = true;
        globalThis.__sitrecWakeRenderLoop?.();
    },

    // While set, playback cannot be resumed. Held by analyses that drive par.frame themselves
    // (Star Tracker's detect pass steps the video frame by frame), where a stray play - from the
    // transport bar, a keyboard shortcut, or a script - would fight the analysis for the frame
    // counter and quietly corrupt the pass. Pausing is always allowed; only resuming is blocked.
    pausedLock: false,

    get paused() {
        return this._paused;
    },
    set paused(value) {
        const nextPaused = Boolean(value);
        if (this.pausedLock && !nextPaused) {
            return;
        }
        const wasPaused = this._paused;
        this._paused = nextPaused;

        if (wasPaused && !nextPaused) {
            globalThis.__sitrecWakeRenderLoop?.();
        }
    },


    glareStartAngle: 90 - 32.3,  // 26.6, (32.3 for keyframes, 26.6 for auto)
    initialGlareRotation: 6,
    useRecordedBank: true,
    showVideo: true,
    showGraphs: true,
    showJet: true,
    podPitchPhysical: 0,
    podPitchIdeal: 0, // ideal roll to point at target
    globalRoll: 0, // total roll needed
    podRollIdeal: 0, // ideal roll from the pod = globalRoll-jetRoll
    podRollPhysical: 0, // physical roll of the pod head = ideal roll or angle from glare
    deroFromGlare: false,
    horizonMethod: "Human Horizon",
    showPodHead: false,
    showPodsEye: false,
    graphSize: 100,
    videoZoom: 100,
    glareAngleType: 4,
    azType: 0,
//    aFrame:0,
//    bFrame:Frames-1,
    pingPong: false,
    scaleJetPitch: true,
    direction: 1,  // 1 or -1
    speed: 1,
    playbackSpeed: 1,  // Multiplier on the per-tick frame advance during playback (Time menu slider)
    podWireframe: false,
    showPointer: false,
    showSphericalGrid: true,
    showAzElGrid: true,
    jetOffset: 1.5,
    showCueData: false,
    showGlareGraph: false,
    showChart: false,
    showKeyboardShortcuts: false,
    TAS: 351,
    integrate: 1,
    showLookCam: true,
    //  lookFOV:0.35,
    mainFOV: 30,
    trackToTrackStopAt: 0,
    jetHeading: 0,
    effects: true,
    negateEl: false,
}


// somewhat messy, but needed to support legacy code for now
// par needs to be a PERMANENT object, so we can't just replace it with a new object
// so we need to reset it to its default values
export function resetPar() {

    // remove all properties from par
    for (const prop in par) {
        delete par[prop];
    }
    // copy all properties from parDefaults to par, preserving getters/setters
    for (const prop of Object.getOwnPropertyNames(parDefaults)) {
        const descriptor = Object.getOwnPropertyDescriptor(parDefaults, prop);
        Object.defineProperty(par, prop, descriptor);
    }

}
