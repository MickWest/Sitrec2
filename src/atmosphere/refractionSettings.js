// The Effects > Atmospheric Refraction folder: one master switch, two models.
//
// Model chooses between Standard refraction and Ray-traced refraction
// (src/refraction/, one view drawn through an atmosphere defined by profiles;
// the other views keep Standard). The folder shows only the chosen model's
// settings. The choice is Sit.raytracedRefraction.enabled, so saves from before
// the folder was merged load with the model they were saved with.
//
// Standard refraction models two things with different physics — the
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

import {Globals, guiMenus, NodeMan, setRenderOne, Sit} from "../Globals";
import {setRayGeometryUniforms} from "../refraction/RayGeometryProjection";
import {getRefractionTool, openRefractionTool} from "../refraction/RefractionLoader";
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
// The rows that belong to one model. updateRefractionGUIState() shows one set.
let standardControllers = [];
let rayTracedControllers = [];

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
        const rayContext = camera?._rayGeometryPass?.geometryContext();
        setRayGeometryUniforms(camera, rayContext);

        // Fisheye and Flat Earth are not pinhole projections. Each switches frustum
        // culling off for every object while it is on, and puts it back itself, so
        // while either is on this hook leaves frustum culling alone.
        const projectionOwnsCulling = !!(Globals.fisheye?.enabled || Globals.flatEarthRendering);

        if (!opts.enabled && !rayContext) {
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
            cullLoftedObjects(_loftedObjects, camera, rayContext ?? terrestrialLiftContext(_cameraPosition, opts));
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
export function currentTerrestrialLiftContext(observerECEF, camera, options) {
    if (Sit.refraction === false || Sit.refractionTerrain === false) return null;
    const rayView = Sit.raytracedRefraction?.enabled
        ? NodeMan?.get(Sit.raytracedRefraction.view, false) : null;
    if (camera && rayView?.camera === camera) {
        if (camera.position.distanceToSquared(observerECEF) >= 0.0004) return null;
        return rayView.raytracedRefraction?.geometryContext(options) ?? null;
    }
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

// Show the chosen model's rows. Grey out whichever of the two ways to set k is
// not in force, so the folder can never offer an editable gradient AND an
// editable k at once. RefractionTool.sync() calls this too, because the
// ray-traced panel has its own Enable checkbox.
export function updateRefractionGUIState() {
    const override = !!Sit.terrestrialRefractionOverrideK;
    if (lapseRateController) override ? lapseRateController.disable() : lapseRateController.enable();
    if (terrestrialKController) override ? terrestrialKController.enable() : terrestrialKController.disable();
    const rayTraced = !!Sit.raytracedRefraction?.enabled;
    for (const controller of standardControllers) controller.show(!rayTraced);
    for (const controller of rayTracedControllers) controller.show(rayTraced);
}

export function setupRefractionGUI() {
    ensureRefractionSettings();

    const folder = guiMenus.refraction;
    if (!folder) return;
    // The folder is a permanent shell whose contents are destroyed between
    // sitches, so an empty one means this sitch has not built it yet. Whichever
    // of the two owning nodes is created first does the work.
    if (folder.controllers && folder.controllers.length > 0) return;
    standardControllers = [];
    rayTracedControllers = [];

    const changed = () => {
        applyRefractionMaster();
        getRefractionTool()?.sync();
        NodeMan?.get("terrainUI", false)?.requestSubdivisionPass();
        setRenderOne(true);
    };

    folder.add(Sit, "refraction").listen()
        .name("Enable Refraction")
        .onChange(changed)
        .tooltip("Turn atmospheric refraction on or off in every view, for either model. Off means light travels in straight lines. The ray-traced atmosphere is kept while refraction is off.")
        .asFolderToggle();

    // The model is Sit.raytracedRefraction.enabled, so a save made before this
    // folder existed loads with the model it was made with.
    const raytraced = () => Sit.raytracedRefraction ?? (Sit.raytracedRefraction = {});
    const model = {
        get model() { return Sit.raytracedRefraction?.enabled ? "rayTraced" : "standard"; },
        set model(value) { raytraced().enabled = value === "rayTraced"; },
    };
    folder.add(model, "model", {"Standard": "standard", "Ray-traced": "rayTraced"}).listen()
        .name("Model")
        .onChange(value => {
            // The tool's chunk loads only when Ray-traced is first chosen. If it
            // cannot load, the loader sets the model back to Standard.
            if (value === "rayTraced") openRefractionTool(false).catch(() => {}).finally(updateRefractionGUIState);
            updateRefractionGUIState();
            changed();
        })
        .tooltip("Standard: every view uses the approximate bends below. Saemundsson's formula moves the sky, and k*d/(2R) raises terrain and buildings.\n"
            + "Ray-traced: one 3D view is drawn by tracing light through an atmosphere that you define with temperature and humidity profiles. This can show mirages and terrain beyond the horizon. The other views keep the Standard model with its last settings.");

    folder.add(Sit, "refractionTerrain").listen()
        .name("Terrain and Buildings")
        .onChange(changed)
        .tooltip("Refract terrain, buildings and the sea.\nStandard raises them by the angle k*d/(2R), where d is the distance and R is the Earth's radius. With the default k (about 0.18) and a camera near the ground, that is about 0.9' (arcminutes) at 20 km and 4.7' at 100 km.\nRay-traced Terrain Geometry needs this on.\nDisplay only: ground elevations, line-of-sight and altitude readouts stay geometric.");

    folder.add(Sit, "refractionSky").listen()
        .name("Sky")
        .onChange(changed)
        .tooltip("Refract the Sun, Moon, planets, stars and satellites.\nStandard raises them toward the zenith with Saemundsson's formula. The bend is about 29' (arcminutes) at the horizon, and less for a high camera.");

    // Ray-traced rows forward each edit to the tool, which traces again when the
    // optics change and moves its pass when the view changes. They are shown
    // only for the Ray-traced model, so the tool is loaded whenever they can be
    // edited; until it loads they show its defaults.
    const rayChanged = optical => {
        getRefractionTool()?.changed(optical);
        NodeMan?.get("terrainUI", false)?.requestSubdivisionPass();
        setRenderOne(true);
    };
    const rayRows = {
        get view() { return Sit.raytracedRefraction?.view ?? "lookView"; },
        set view(value) { raytraced().view = value; },
        get rendering() { return Sit.raytracedRefraction?.projectionMode ?? "screen"; },
        set rendering(value) { raytraced().projectionMode = value; },
        get traceKm() { return (Sit.raytracedRefraction?.maxDistance ?? 50000) / 1000; },
        set traceKm(value) { raytraced().maxDistance = Math.round(value * 1000); },
        open: () => openRefractionTool().catch(() => {}),
    };
    rayTracedControllers.push(
        folder.add(rayRows, "view", {"Look View": "lookView", "Main View": "mainView"}).listen()
            .name("Ray-traced View")
            .onChange(() => rayChanged(false))
            .tooltip("The 3D view that is drawn through the ray-traced atmosphere. Only one view is ray-traced. The other views use the Standard model."),
        folder.add(rayRows, "rendering", {"Screen-space Mirages": "screen", "Terrain Geometry": "geometry"}).listen()
            .name("Rendering")
            .onChange(() => rayChanged(true))
            .tooltip("Screen-space Mirages bends the rendered image. It can show folded images of surfaces that are already visible, but it cannot show hidden surfaces.\n"
                + "Terrain Geometry moves the terrain through the traced rays before the depth test, so terrain beyond the geometric horizon can appear, out to Trace Distance. It needs a ray fan without folds."),
        folder.add(rayRows, "traceKm", 0.1, 1000, 0.1).listen()
            .name("Trace Distance (km)")
            // A slider sends a value at every step of a drag. Trace once, on release.
            .onFinishChange(() => rayChanged(true))
            .tooltip("How far each ray is traced. Terrain Geometry can show terrain out to this distance. A longer distance takes longer to trace."),
        folder.add(rayRows, "open")
            .name("Profiles, Rays & Lasers…")
            .tooltip("Open the Ray-traced Refraction panel. In it you edit the temperature and humidity profiles, see the ray paths and the diagnostics, add lasers, and export or import a profile."),
    );

    standardControllers.push(folder.add(Sit, "refractionPressure", 800, 1100, 1).listen()
        .name("Refraction Pressure (hPa)")
        .onChange(() => setRenderOne(true))
        .tooltip("Air pressure, in hPa (hectopascals). Both Sky and Terrain and Buildings use it. The default is 1010 hPa."));

    standardControllers.push(folder.add(Sit, "refractionTemp", -40, 50, 1).listen()
        .name("Refraction Temperature (°C)")
        .onChange(() => setRenderOne(true))
        .tooltip("Air temperature, in °C. Both Sky and Terrain and Buildings use it. The default is 10 °C."));

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

    const overrideKController = folder.add(Sit, "terrestrialRefractionOverrideK").listen()
        .name("Override k")
        .onChange(() => { updateRefractionGUIState(); setRenderOne(true); })
        .tooltip("Set k by hand instead of deriving it from pressure, temperature and gradient — for fitting k directly to a measured target. The derived inputs then stop affecting it.");
    standardControllers.push(lapseRateController, terrestrialKController, overrideKController);

    updateRefractionGUIState();
}
