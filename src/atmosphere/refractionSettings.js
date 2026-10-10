// The View > Atmospheric Refraction folder: one master switch, two halves.
//
// Sitrec models refraction in two places with different physics — the
// whole-atmosphere Saemundsson bend for celestial objects (./refraction.js) and
// the range-dependent bend for the solid scene (./terrestrialRefraction.js).
// They share the same air, so you rarely want one without the other; the master
// switch is what couples them, and the two checkboxes only exist to take one
// half back out when you are deliberately isolating an effect.
//
// The folder is built here rather than in the nodes that own each half, because
// either node may be absent: a star-only sitch has no CNodeTerrainUI, a
// terrain-only one has no CNodeDisplayNightSky. Both call setupRefractionGUI()
// and whichever runs first builds the whole folder.
//
// Sit.refractionEnabled and Sit.terrestrialRefraction stay the flags every
// consumer reads. They are now DERIVED from the master and their checkbox, so
// nothing downstream had to change.

import {Globals, guiMenus, setRenderOne, Sit} from "../Globals";
import {GlobalScene} from "../LocalFrame";
import {REFRACTION_DEFAULTS} from "./refraction";
import {Vector3} from "three";
import {
    cullLoftedObjects,
    liftWorldPoint,
    resolveTerrestrialK,
    restoreLoftedCulling,
    sweepTerrestrialRefraction,
    TERRESTRIAL_REFRACTION_DEFAULTS,
    terrestrialLiftContext,
    terrestrialOptsFrom,
    updateTerrestrialRefractionUniforms,
} from "./terrestrialRefraction";

let lapseRateController = null;
let terrestrialKController = null;

// Fill in defaults, and migrate a sitch saved before the master existed.
export function ensureRefractionSettings() {
    if (Sit.refraction === undefined) {
        // Pre-master sitches carry only the old single "Atmospheric Refraction"
        // checkbox, which drove the sky. Promote it to the master and switch
        // both halves on: a sitch that wanted a refracted sky wants refracted
        // ground under it, which is the whole point of the coupling.
        Sit.refraction = Sit.refractionEnabled ?? REFRACTION_DEFAULTS.enabled;
        Sit.refractionSky = true;
        Sit.refractionTerrain = true;
    }
    if (Sit.refractionPressure === undefined) Sit.refractionPressure = REFRACTION_DEFAULTS.pressureHPa;
    if (Sit.refractionTemp === undefined) Sit.refractionTemp = REFRACTION_DEFAULTS.tempC;
    if (Sit.terrestrialLapseRate === undefined) {
        Sit.terrestrialLapseRate = TERRESTRIAL_REFRACTION_DEFAULTS.lapseRateKPerKm;
    }
    if (Sit.terrestrialRefractionOverrideK === undefined) {
        Sit.terrestrialRefractionOverrideK = TERRESTRIAL_REFRACTION_DEFAULTS.overrideK;
    }
    if (Sit.terrestrialRefractionK === undefined) {
        Sit.terrestrialRefractionK = TERRESTRIAL_REFRACTION_DEFAULTS.k;
    }
    applyRefractionMaster();
    installTerrestrialRefractionSceneHook(GlobalScene);
}

// The terrestrial bend is observer-relative, so the shared uniforms have to be
// re-pointed at whichever camera is about to draw. Doing that per render-call-site
// is a losing game: GlobalScene is also rendered by the aerial-perspective depth
// prepass, the long-exposure occlusion mask, video export, scripted video, XR,
// and — six times, with six different cameras — by CubeCamera.update() for
// environment-mapped CNode3DObjects. Miss one and it renders with a stale or
// flatly wrong bend axis.
//
// Three calls scene.onBeforeRender after it has updated the scene and camera
// matrices and resolved the XR camera, but before it builds the render list, so
// one chained hook covers every one of those paths with the right camera.
let _sceneHookInstalled = null;

// Coverage sweep cadence. New materials appear when a model finishes loading or
// a node is added, not every frame, so walking the scene every frame would be
// pure waste. Once every SWEEP_INTERVAL_MS bounds the latency for a newly added
// object to well under a second while costing nothing measurable; and when
// refraction is switched off the sweep does not run at all, so the whole
// mechanism costs nothing for anyone who turns it back off.
const SWEEP_INTERVAL_MS = 500;
let _lastSweepMs = -1e9;

// The objects the last sweep found drawn lofted, for the frustum test below.
let _loftedObjects = [];
const _cameraPosition = new Vector3();

export function installTerrestrialRefractionSceneHook(scene) {
    if (!scene || _sceneHookInstalled === scene) return;
    const previous = scene.onBeforeRender;
    scene.onBeforeRender = function (renderer, sceneArg, camera, renderTarget) {
        if (typeof previous === "function") {
            previous.call(this, renderer, sceneArg, camera, renderTarget);
        }
        const opts = terrestrialOptsFrom(Sit, Globals);
        updateTerrestrialRefractionUniforms(camera, opts);

        // Fisheye and Flat Earth are not pinhole projections. Each switches frustum
        // culling off for every object while it is on, and puts it back itself, so
        // while either is on this hook leaves frustum culling alone.
        const projectionOwnsCulling = !!(Globals.fisheye?.enabled || Globals.flatEarthRendering);

        if (!opts.enabled) {
            // This render draws nothing lofted (refraction is off, or the ray-traced
            // pass has taken this view over), so Three's own frustum test is right.
            if (!projectionOwnsCulling) {
                restoreLoftedCulling(_loftedObjects);
                // Switched off, not only held off for this view by the ray-traced pass
                // (which leaves the master on): let go of the objects. The first sweep
                // after it is switched on again finds them anew.
                if (!(Sit.refraction && Sit.refractionTerrain)) _loftedObjects = [];
            }
            return;
        }
        const now = performance.now();
        if (now - _lastSweepMs >= SWEEP_INTERVAL_MS) {
            _lastSweepMs = now;
            const lofted = [];
            sweepTerrestrialRefraction(this, -1, lofted);
            _loftedObjects = lofted;
        }
        // Three is about to decide what to draw from each object's PHYSICAL position.
        // Decide it from the lofted position, for this camera.
        if (camera && !projectionOwnsCulling) {
            _cameraPosition.setFromMatrixPosition(camera.matrixWorld);
            cullLoftedObjects(_loftedObjects, camera, terrestrialLiftContext(_cameraPosition, opts));
        }
    };
    _sceneHookInstalled = scene;
}

// Force the next sweep to run immediately rather than waiting out the interval.
export function resetTerrestrialRefractionSweep() {
    _lastSweepMs = -1e9;
}

// Fold the master into the two flags the rest of the app reads.
export function applyRefractionMaster() {
    Sit.refractionEnabled = !!(Sit.refraction && Sit.refractionSky);
    const terrestrial = !!(Sit.refraction && Sit.refractionTerrain);
    if (!terrestrial && Sit.terrestrialRefraction) resetTerrestrialRefractionSweep();
    Sit.terrestrialRefraction = terrestrial;
}

// The sky half's settings as an options block for the CPU refraction helpers
// (applyRefractionFromObserver / applyRefractionToDirection), so a CPU path bends
// by exactly what the sky was drawn with. Reads Sit.refractionEnabled, which
// applyRefractionMaster() derives from the master and the Sky checkbox.
//
// Deliberately carries no observerHeight: those helpers derive it from the
// observer ECEF they are given, which is what makes a camera in orbit get almost
// no bend and one on the ground get the full amount.
//
// (CSatellite predates this and still builds an identical block inline.)
export function currentRefractionOpts() {
    return {
        enabled: Sit.refractionEnabled !== undefined
            ? !!Sit.refractionEnabled
            : REFRACTION_DEFAULTS.enabled,
        pressureHPa: Sit.refractionPressure ?? REFRACTION_DEFAULTS.pressureHPa,
        tempC: Sit.refractionTemp ?? REFRACTION_DEFAULTS.tempC,
        // Refraction bends about the local vertical, which depends on the active
        // earth model (Sit.useEllipsoid): the radial on a sphere, the geodetic
        // normal on an ellipsoid. These track it.
        equatorRadius: Globals.equatorRadius,
        polarRadius: Globals.polarRadius,
    };
}

// The terrestrial half's settings resolved against the live app state, for the
// CPU twin of the shader lift. Screen-space code — drawing a marker over the
// terrain it sits on, picking the surface under a click, matching video pixels
// to landmarks — must project the APPARENT position or it disagrees with the
// render by the whole bend, which at long range is tens of pixels.
//
// Returns null when refraction is off, so every caller's fast path is "no
// context, no work" rather than an identity transform.
export function currentTerrestrialLiftContext(observerECEF) {
    return terrestrialLiftContext(observerECEF, terrestrialOptsFrom(Sit, Globals));
}

// Where to AIM a camera so that a world point lands on its boresight.
//
// The scene is drawn lofted, so a camera aimed at a point's geometric position
// looks below where that point is drawn: 0.085 degrees at 160 km from a 3.5 km
// camera, which is three quarters of the half-height of a 0.22 degree field of
// view. Aim at this instead. With refraction off it returns the point unchanged.
export function apparentPositionFrom(observerECEF, worldECEF, target = new Vector3()) {
    return liftWorldPoint(currentTerrestrialLiftContext(observerECEF), worldECEF, target);
}

// Grey out whichever of the two ways to set k is not in force, so the folder can
// never offer an editable gradient AND an editable k at once.
export function updateRefractionGUIState() {
    const override = !!Sit.terrestrialRefractionOverrideK;
    if (lapseRateController) override ? lapseRateController.disable() : lapseRateController.enable();
    if (terrestrialKController) override ? terrestrialKController.enable() : terrestrialKController.disable();
}

export function setupRefractionGUI() {
    ensureRefractionSettings();

    const folder = guiMenus.refraction;
    if (!folder) return;
    // The folder is a permanent shell whose contents are destroyed between
    // sitches, so an empty one means this sitch has not built it yet. Whichever
    // of the two owning nodes is created first does the work.
    if (folder.controllers && folder.controllers.length > 0) return;

    const changed = () => { applyRefractionMaster(); setRenderOne(true); };

    folder.add(Sit, "refraction").listen()
        .name("Enable Refraction")
        .onChange(changed)
        .tooltip("Master switch for atmospheric refraction. Off means light travels in straight lines — geometrically simple, but not what a camera sees near the horizon.")
        .asFolderToggle();

    folder.add(Sit, "refractionTerrain").listen()
        .name("Terrain and Buildings")
        .onChange(changed)
        .tooltip("Loft distant terrain, buildings and the sea by k*d/(2R) — about 0.7' at 20 km, 3.4' at 100 km. Display only: ground elevations, line-of-sight and altitude readouts stay geometric.");

    folder.add(Sit, "refractionSky").listen()
        .name("Sky")
        .onChange(changed)
        .tooltip("Bend Sun/Moon/planet/star apparent positions toward the zenith via Saemundsson's formula — about 29' at the horizon.");

    folder.add(Sit, "refractionPressure", 800, 1100, 1).listen()
        .name("Refraction Pressure (hPa)")
        .onChange(() => setRenderOne(true))
        .tooltip("Atmospheric pressure. Feeds BOTH halves. Stellarium default: 1010 hPa");

    folder.add(Sit, "refractionTemp", -40, 50, 1).listen()
        .name("Refraction Temperature (°C)")
        .onChange(() => setRenderOne(true))
        .tooltip("Air temperature. Feeds BOTH halves. Stellarium default: 10 °C");

    lapseRateController = folder.add(Sit, "terrestrialLapseRate", -35, 50, 0.5).listen()
        .name("Surface Temp Gradient (K/km)")
        .onChange(() => setRenderOne(true))
        .tooltip("Temperature change with height in the air the sight line passes through. -6.5 is the standard lapse rate; -9.8 dry adiabatic; -13.7 reproduces the traditional surveying k=0.13 (a sun-warmed land surface). POSITIVE is an inversion — routine over water at night, and it raises k sharply.");

    // One k row doing both jobs. The proxy reads back whatever is actually in
    // force, so with the override off it tracks the derived value live (and is
    // disabled), and with it on the same row edits the stored one.
    const kProxy = {
        get k() { return resolveTerrestrialK(Sit); },
        set k(v) { Sit.terrestrialRefractionK = v; },
    };
    terrestrialKController = folder.add(kProxy, "k", 0, 0.6, 0.005).listen()
        .name("Refraction Coefficient k")
        .onChange(() => setRenderOne(true))
        .tooltip("k = 503 * (P/T^2) * (0.0342 + dT/dh) — derived from the pressure and temperature above plus the gradient, so it is NOT independent of them. Tick Override to type it in directly instead.");

    folder.add(Sit, "terrestrialRefractionOverrideK").listen()
        .name("Override k")
        .onChange(() => { updateRefractionGUIState(); setRenderOne(true); })
        .tooltip("Set k by hand instead of deriving it from pressure, temperature and gradient — for fitting k directly to a measured target. The derived inputs then stop affecting it.");

    updateRefractionGUIState();
}
