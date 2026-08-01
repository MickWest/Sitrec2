import {saveAs} from "file-saver";
import {Vector3} from "three";
import {GlobalDateTimeNode, Globals, NodeMan, setRenderOne, Sit} from "./Globals";
import {par} from "./par";
import {ViewMan} from "./CViewManager";
import {altitudeHAE, getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "./SphericalMath";
import {closeFullscreen, ExportProgressWidget, getExportPrefix, isFullscreen, openFullscreen} from "./utils";
import {radians} from "./mathUtils";
import {targetSphere} from "./JetStuffVars";
import {waitForExportFrameSettled} from "./ExportFrameSettler";
import {forceShadowRefreshForExport} from "./nodes/CNodeView3D";
import {CNodeGUIValue} from "./nodes/CNodeGUIValue";
import {saveFileToDirectory} from "./FileUtils";
import {isAbortLikeError, supportsDirectoryPicker} from "./CFileManagerUtils";
import {
    createDesktopDirectoryHandle,
    getDesktopFileSystemBridge,
    isDesktopFileSystemAvailable,
} from "./DesktopFileSystem";

// Max output width for the Fullscreen variant. Inputs wider than this are
// downscaled (preserving aspect) before PNG encoding.
const FULLSCREEN_MAX_WIDTH = 1920;

// Resolve a world-space point for the "target" the look camera should orbit.
// If trackKey is provided and resolves to a position node on targetTrackSwitch,
// that track's position at par.frame is used.
//
// Fallback policy: if trackKey is falsy or the *default sentinel* "fixedTarget",
// we silently fall through to the legacy targetObject / targetTrack / targetSphere
// resolution. For any other explicit user choice, a missing or non-positional
// track returns null — the caller is expected to alert. This avoids quietly
// orbiting some other entity when the user's chosen track has been renamed,
// removed, or never carried a `.p()` (e.g. a non-track node).
function resolveTargetPosition(trackKey) {
    const out = new Vector3();

    if (trackKey) {
        const targetTrackSwitch = NodeMan.get("targetTrackSwitch", false);
        const node = targetTrackSwitch?.inputs?.[trackKey];
        if (node && typeof node.p === "function") {
            const p = node.p(par.frame);
            if (p) return out.copy(p);
        }
        // Explicit user choice that we can't honor: fail closed.
        if (trackKey !== "fixedTarget") return null;
    }

    const targetObject = NodeMan.get("targetObject", false)
        ?? NodeMan.get("traverseObject", false);
    if (targetObject && targetObject._object) {
        targetObject._object.getWorldPosition(out);
        return out;
    }

    const targetTrack = NodeMan.get("targetTrack", false);
    if (targetTrack && typeof targetTrack.p === "function") {
        const p = targetTrack.p(par.frame);
        if (p) return out.copy(p);
    }

    // Jet sitches (ATFLIR pod) expose targetSphere as a THREE.Object3D in world space.
    if (targetSphere) {
        targetSphere.getWorldPosition(out);
        return out;
    }

    return null;
}

// Build {key: key} options object from the current targetTrackSwitch inputs.
// Always include the user's currently-chosen key so a missing-track state is
// still selectable (and doesn't silently flip to something else).
function buildTrackOptions(currentChoice) {
    const opts = {};
    const targetTrackSwitch = NodeMan.get("targetTrackSwitch", false);
    if (targetTrackSwitch?.inputs) {
        for (const key of Object.keys(targetTrackSwitch.inputs)) {
            opts[key] = key;
        }
    }
    if (currentChoice && opts[currentChoice] === undefined) {
        opts[currentChoice] = currentChoice;
    }
    if (Object.keys(opts).length === 0) {
        opts.fixedTarget = "fixedTarget";
    }
    return opts;
}

// Encode the source canvas as an image blob, downscaling to maxWidth if
// requested and the source is larger. Aspect ratio is preserved. mimeType is
// "image/png" or "image/jpeg"; quality only applies to JPEG.
function canvasToImageBlob(canvas, maxWidth, mimeType = "image/png", quality = 0.9) {
    if (!maxWidth || canvas.width <= maxWidth) {
        return new Promise((resolve) => canvas.toBlob(resolve, mimeType, quality));
    }
    const scale = maxWidth / canvas.width;
    const w = Math.max(1, Math.round(canvas.width * scale));
    const h = Math.max(1, Math.round(canvas.height * scale));
    const out = document.createElement("canvas");
    out.width = w;
    out.height = h;
    const ctx = out.getContext("2d");
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(canvas, 0, 0, w, h);
    return new Promise((resolve) => out.toBlob(resolve, mimeType, quality));
}

// Ask the user to pick the folder the image set will be written into.
// Returns one of:
//   FileSystemDirectoryHandle — write each image straight into this folder
//   null  — no folder picker in this environment; fall back to collecting
//           the images into a zip download (the legacy behavior)
//   false — the user cancelled the picker; abort the export entirely
// Desktop (Electron) builds route through the native chooseFolder dialog and
// wrap the result in a directory-handle shim so the write path is identical.
async function pickImageSetOutputFolder() {
    if (isDesktopFileSystemAvailable()) {
        const desktopFs = getDesktopFileSystemBridge();
        if (typeof desktopFs.chooseFolder === "function") {
            try {
                const selection = await desktopFs.chooseFolder({});
                if (!selection) return false;
                return createDesktopDirectoryHandle(selection.path);
            } catch (err) {
                if (isAbortLikeError(err)) return false;
                console.warn("Image set export: desktop folder picker failed, falling back to zip", err);
                return null;
            }
        }
    }
    if (!supportsDirectoryPicker()) {
        console.warn("Image set export: no folder picker in this browser, falling back to zip download");
        return null;
    }
    try {
        // id makes Chrome remember the last-used folder for this picker
        // independently of the other pickers in the app.
        return await window.showDirectoryPicker({mode: "readwrite", id: "orbit-image-set"});
    } catch (err) {
        if (isAbortLikeError(err)) return false;
        console.warn("Image set export: folder picker failed, falling back to zip", err);
        return null;
    }
}

// Solve for the distance `d` along the unit ECEF direction `dir` (pointing from
// `target` toward the camera) such that the camera's geodetic altitude (HAE)
// equals `altMeters`. Positions are ECEF — the world/render frame, see
// docs/TransitionToECEF.md — so altitudeHAE() applies directly. Moving along
// `dir` away from the target monotonically increases the geocentric radius, so
// altitude is monotonic in d and a doubling-bracket + bisection converges
// (and stays finite even at near-horizontal elevations, where the camera ends
// up far out at the chosen altitude, lifted there by Earth curvature).
//
// Returns null if `altMeters` is at or below the target's own altitude — the
// camera would have to sit below the target, which our 0..90° look-down sweep
// never does.
function solveDistanceForHAE(target, dir, altMeters) {
    const targetAlt = altitudeHAE(target);
    if (!isFinite(altMeters) || altMeters <= targetAlt + 1e-3) return null;
    const probe = new Vector3();
    const haeAt = (d) => altitudeHAE(probe.copy(target).addScaledVector(dir, d));
    let lo = 0;
    let hi = Math.max(altMeters - targetAlt, 1000);
    // Expand hi until it brackets the target altitude. Low elevations need a
    // large mostly-horizontal distance before curvature lifts HAE to altMeters.
    let guard = 0;
    while (haeAt(hi) < altMeters && guard++ < 80) hi *= 2;
    // Bisect to ~0.5 m (well below any visible difference at orbit ranges).
    for (let i = 0; i < 60 && (hi - lo) > 0.5; i++) {
        const mid = 0.5 * (lo + hi);
        if (haeAt(mid) < altMeters) lo = mid; else hi = mid;
    }
    return 0.5 * (lo + hi);
}

export class ImageSetExporter {
    constructor() {
        this.azStart = 0;
        this.azStep = 45;
        this.elStep = 20;
        this.elStart = 10;
        this.trackToOrbit = "fixedTarget";
        this.timeStepMinutes = 120;
        this.numTimeSteps = 1;
        // Orbit constraint mode: "distance" keeps a fixed slant range to the
        // target; "altitude" keeps the camera at a fixed geodetic altitude (HAE)
        // and lets each elevation step set how far out the camera sits.
        this.orbitMode = "distance";
        this.useCurrentDistance = true;
        this.useCurrentAltitude = true;
        this.useCurrentFOV = true;
        this.verticalFOV = 30;
        this.usePNGs = false;
        this.orbitPreview = false;

        // Preview state — populated by _enterPreview, cleared by _exitPreview.
        this._previewState = null;
    }

    setupMenu(parentFolder) {
        // Idempotent: a sitch reload tears down non-perm GUI children of the
        // perm Export folder, so this is re-called from sitchChanged(). Drop
        // any previous folder + the orbit-distance node so we rebuild cleanly.
        if (this.menuFolder) {
            this.menuFolder.destroy();
            this.menuFolder = null;
        }
        if (NodeMan.exists("imageSetOrbitDistance")) {
            NodeMan.disposeRemove("imageSetOrbitDistance");
        }
        if (NodeMan.exists("imageSetOrbitAltitude")) {
            NodeMan.disposeRemove("imageSetOrbitAltitude");
        }

        const folder = parentFolder.addFolder("Orbit Image Set").close()
            .tooltip("Export a set of images of the look view from az/el positions around the target into a folder you choose, optionally stepping the sitch time forward between sweeps");
        this.menuFolder = folder;

        // Track selector — options are rebuilt from targetTrackSwitch each time
        // the folder is opened so newly-imported KML/MISB tracks show up.
        this.trackController = folder.add(this, "trackToOrbit", buildTrackOptions(this.trackToOrbit))
            .name("Track to Orbit")
            .tooltip("Track whose position at the current frame is the orbit center. Drawn from the same list as the Target Track switch.");

        folder.add(this, "azStart", 0, 355, 5)
            .name("AZ Start (deg)")
            .tooltip("Starting azimuth in degrees (0-355, multiples of 5). 0 = North; sweeps clockwise from here.");
        folder.add(this, "azStep", 0, 90, 5)
            .name("AZ Step (deg)")
            .tooltip("Azimuth step (0-90, multiples of 5). 360 / azStep images per elevation. Set to 0 to take a single shot at AZ Start.");
        folder.add(this, "elStart", 0, 80, 1)
            .name("EL Start (deg)")
            .tooltip("Lowest elevation in the sweep (0-80). 0 = horizontal, higher values skip the most grazing angles.");
        folder.add(this, "elStep", 0, 90, 1)
            .name("EL Step (deg)")
            .tooltip("Elevation step (0-90). Sweeps from EL Start to 90 (straight down) inclusive. Set to 0 to take a single sweep at EL Start.");
        // Orbit constraint selector: fixed slant distance vs fixed altitude.
        // Switching toggles which control pair (distance vs altitude) is shown;
        // the AZ/EL sweep applies to both modes.
        this.orbitModeController = folder.add(this, "orbitMode",
            {"Fixed Distance": "distance", "Fixed Altitude": "altitude"})
            .name("Orbit Mode")
            .tooltip("Fixed Distance: orbit at a constant slant range to the target (camera altitude rises with elevation). Fixed Altitude: hold the camera at a constant altitude above sea level (HAE); each elevation step sets how far out the camera sits.")
            .onChange(() => {
                this._updateOrbitModeVisibility();
                // The preview snapshots the orbit mode at enter time, so re-enter
                // when the mode changes mid-preview — otherwise the new mode (and
                // its validation) wouldn't take effect until preview is re-toggled.
                if (this.orbitPreview) {
                    this._exitPreview();
                    if (!this._enterPreview()) {
                        this.orbitPreview = false;
                        this.orbitPreviewController?.updateDisplay();
                    }
                }
            });

        // Orbit distance: a checkbox to use the current camera-to-target
        // distance, OR a manual distance slider in big units (NM / mi / km).
        this.useCurrentDistanceController = folder.add(this, "useCurrentDistance")
            .name("Use Current Camera Distance")
            .tooltip("If on, the orbit radius is the current distance from the look camera to the target. If off, use the Orbit Distance slider below.")
            .onChange(() => this._updateOrbitModeVisibility());

        // Distance slider. unitType "big" means the slider displays NM/mi/km
        // depending on the user's units setting, and getValueFrame(0) returns
        // meters. The initial value is in big units (≈5 km / 5 mi / 5 NM).
        if (!NodeMan.exists("imageSetOrbitDistance")) {
            this.orbitDistanceNode = new CNodeGUIValue({
                id: "imageSetOrbitDistance",
                value: 5,
                start: 0.01,
                end: 500,
                step: 0.01,
                maxMax: 10000,
                elastic: true,
                elasticMin: 0.01,
                elasticMax: 1000,
                unitType: "big",
                desc: "Orbit Distance",
                tooltip: "Orbit radius around the target (large units). Only used when 'Use Current Camera Distance' is off.",
            }, folder);
        } else {
            this.orbitDistanceNode = NodeMan.get("imageSetOrbitDistance");
        }

        // Fixed-altitude controls mirror the distance pair: a checkbox to use
        // the look camera's current altitude, or a manual Orbit Altitude slider
        // in small units (ft / m). Only relevant in "altitude" orbit mode.
        this.useCurrentAltitudeController = folder.add(this, "useCurrentAltitude")
            .name("Use Current Camera Altitude")
            .tooltip("If on, hold the orbit at the look camera's current altitude above sea level (HAE). If off, use the Orbit Altitude slider below.")
            .onChange(() => this._updateOrbitModeVisibility());

        // Altitude slider. unitType "small" displays ft/m per the user's units
        // setting; getValueFrame(0) returns meters (HAE). Default value is in
        // small units (30000 ft / 30000 m).
        if (!NodeMan.exists("imageSetOrbitAltitude")) {
            this.orbitAltitudeNode = new CNodeGUIValue({
                id: "imageSetOrbitAltitude",
                value: 5,
                start: 0,
                end: 500,
                step: 100,
                maxMax: 10000,
                elastic: true,
                elasticMin: 0,
                elasticMax: 10000,
                unitType: "big",
                desc: "Orbit Altitude",
                tooltip: "Camera altitude above sea level (HAE) for the orbit. Each elevation step places the camera at this altitude, varying how far out it sits. Only used when 'Use Current Camera Altitude' is off.",
            }, folder);
        } else {
            this.orbitAltitudeNode = NodeMan.get("imageSetOrbitAltitude");
        }

        // Set initial visibility of the distance/altitude control pairs to match
        // the current orbit mode and "Use Current ..." checkboxes.
        this._updateOrbitModeVisibility();

        // Vertical FOV: checkbox to use the look camera's current FOV, or
        // a manual vertical FOV slider in degrees. Mirrors the distance pattern.
        this.useCurrentFOVController = folder.add(this, "useCurrentFOV")
            .name("Use Current Camera FOV")
            .tooltip("If on, render at the look camera's current vertical FOV. If off, use the Vertical FOV slider below.")
            .onChange((on) => {
                if (this.verticalFOVController) {
                    if (on) this.verticalFOVController.hide();
                    else this.verticalFOVController.show();
                }
            });

        this.verticalFOVController = folder.add(this, "verticalFOV", 0.001, 120, 0.001)
            .name("Vertical FOV (deg)")
            .tooltip("Vertical field of view in degrees. Only used when 'Use Current Camera FOV' is off.");
        // Initially hidden because useCurrentFOV defaults to true.
        this.verticalFOVController.hide();

        folder.add(this, "timeStepMinutes", 0, 1440, 1)
            .name("Time Step (minutes)")
            .tooltip("Minutes to advance the sitch start time between successive sweeps. Ignored when Number of Time Steps is 1.");
        folder.add(this, "numTimeSteps", 1, 240, 1)
            .name("Number of Time Steps")
            .tooltip("How many time-stepped sweeps to render. Step 0 uses Sit.startTime; step N adds N * Time Step.");
        folder.add(this, "usePNGs")
            .name("Use PNGs")
            .tooltip("Off (default): save each shot as JPEG. Much faster to encode (5-20x), smaller files, but lossy compression (subtle blocking around high-contrast edges, slight color shift). Recommended for previews, large sweeps, and shots dominated by terrain/sky. On: save lossless PNG. Pixel-perfect, larger files, slower per shot — use when you need to compare against a reference image or scrub for sub-pixel artifacts.");

        this.orbitPreviewController = folder.add(this, "orbitPreview")
            .name("Orbit Preview")
            .tooltip("When on, repurpose the frame slider as an index into the orbit shot list. Stepping moves the camera and (between sweeps) advances the sitch time. Turning it off restores the prior camera, time and frame.")
            .onChange((on) => {
                if (on) {
                    const ok = this._enterPreview();
                    if (!ok) {
                        // Validation failed — bounce the checkbox back to off.
                        this.orbitPreview = false;
                        this.orbitPreviewController.updateDisplay();
                    }
                } else {
                    this._exitPreview();
                }
            });

        // Mirror the Lighting Preset dropdown from the Lighting menu. Attached
        // lazily because the lighting node is created by Sit.setup() at
        // index.js:2199, well after FileManager.sitchChanged() fires the
        // initial setupMenu at index.js:2060. We try once sync (for the case
        // where lighting exists already, e.g. a subsequent sitch reload), and
        // also retry on each folder open (the dropdown isn't visible until
        // then anyway) until it lands.
        this._attachLightingPresetMirror = () => {
            if (!this.menuFolder || this.menuFolder !== folder) return; // stale folder
            if (folder.controllers.some(c => c._name === "Lighting Preset")) return; // already added
            const lightingNode = NodeMan.get("lighting", false);
            if (!lightingNode?._lightingPresets) return;
            const ctrl = folder.add(lightingNode, "lightingPreset", Object.keys(lightingNode._lightingPresets))
                .name("Lighting Preset")
                .tooltip("Mirror of the Lighting menu's preset dropdown — applies the same set of values to the lighting sliders, master shadows toggle, and lookView atmosphere flag.")
                .listen()
                .onChange((v) => lightingNode.applyLightingPreset(v));
            // lil-gui's add() appends at the end; re-position the row so it
            // lands just above the "Export Image Set" button.
            const exportBtn = folder.controllers.find(c => c._name === "Export Image Set");
            if (exportBtn?.domElement && ctrl.domElement) {
                folder.$children.insertBefore(ctrl.domElement, exportBtn.domElement);
            }
        };
        this._attachLightingPresetMirror();

        folder.add({
            run: () => this.exportImageSet(),
        }, "run").name("Export Image Set")
            .tooltip("Ask for an output folder, then render the look view at every (time, el, az) and save each image into that folder");
        folder.add({
            runFs: () => this.exportImageSetFullscreen(),
        }, "runFs").name("Export Image Set (Fullscreen)")
            .tooltip(`Like Export Image Set, but enter fullscreen, hide UI/clock/compass/attribution, and render at native effect resolution (capped at ${FULLSCREEN_MAX_WIDTH}px wide)`);

        // Track which key-set is currently in the dropdown so we only rebuild
        // it when the available tracks actually change. This avoids the
        // visible row reorder caused by lil-gui's options() destroying and
        // re-appending the controller on every folder open.
        this.trackOptionsKeySig = Object.keys(buildTrackOptions(this.trackToOrbit)).join("|");

        // Refresh the track dropdown whenever the folder is (re)opened so any
        // tracks the user just drag-dropped become selectable without a reload.
        folder.onOpenClose((g) => {
            if (g._closed) return;
            // Retry attaching the Lighting Preset mirror in case the lighting
            // node wasn't constructed yet at setupMenu time.
            this._attachLightingPresetMirror?.();
            if (!this.trackController) return;

            const newOpts = buildTrackOptions(this.trackToOrbit);
            const newSig = Object.keys(newOpts).join("|");
            if (newSig === this.trackOptionsKeySig) return; // nothing to do

            // lil-gui's options() implementation (lil-gui.esm.js:337) calls
            // parent.add() — which appends the replacement controller at the
            // end of $children — and then destroys the old one. Move the new
            // controller's DOM row back to where the old one was so the
            // "Track to Orbit" row stays at the top of the folder.
            const $children = folder.$children;
            const oldDom = this.trackController.domElement;
            const index = oldDom ? Array.prototype.indexOf.call($children.children, oldDom) : -1;

            this.trackController = this.trackController.options(newOpts)
                .name("Track to Orbit")
                .tooltip("Track whose position at the current frame is the orbit center. Drawn from the same list as the Target Track switch.");
            this.trackOptionsKeySig = newSig;

            if (index >= 0 && this.trackController.domElement) {
                const ref = $children.children[index] || null;
                $children.insertBefore(this.trackController.domElement, ref);
            }
        });

        return folder;
    }

    // Show the control pair (distance vs altitude) that matches the current
    // orbit mode and hide the other; within the active pair the manual slider
    // is shown only when its "Use Current ..." checkbox is off.
    _updateOrbitModeVisibility() {
        const altMode = this.orbitMode === "altitude";
        if (this.useCurrentDistanceController) {
            if (altMode) this.useCurrentDistanceController.hide();
            else this.useCurrentDistanceController.show();
        }
        if (this.orbitDistanceNode?.guiEntry) {
            if (!altMode && !this.useCurrentDistance) this.orbitDistanceNode.guiEntry.show();
            else this.orbitDistanceNode.guiEntry.hide();
        }
        if (this.useCurrentAltitudeController) {
            if (altMode) this.useCurrentAltitudeController.show();
            else this.useCurrentAltitudeController.hide();
        }
        if (this.orbitAltitudeNode?.guiEntry) {
            if (altMode && !this.useCurrentAltitude) this.orbitAltitudeNode.guiEntry.show();
            else this.orbitAltitudeNode.guiEntry.hide();
        }
    }

    // Resolve the target geodetic altitude (HAE, meters) for fixed-altitude
    // orbit mode: either the look camera's current altitude, or the manual
    // Orbit Altitude slider (whose getValueFrame(0) returns SI meters).
    _resolveFixedAltitude(camera) {
        if (this.useCurrentAltitude) return altitudeHAE(camera.position);
        if (this.orbitAltitudeNode) return this.orbitAltitudeNode.getValueFrame(0);
        return altitudeHAE(camera.position);
    }

    // Compute the (az, el) sweep used by both export and preview, plus the
    // full (t, az, el) shot list across time steps. Returns plain numbers
    // (clamped/rounded) so callers don't repeat the validation.
    _buildShotList() {
        const azStep = Math.max(0, Math.round(this.azStep));
        const elStep = Math.max(0, Math.round(this.elStep));
        const elStart = Math.max(0, Math.min(80, Math.round(this.elStart)));
        const azStart = ((Math.round(Number(this.azStart) || 0)) % 360 + 360) % 360;
        const timeStepMinutes = Math.max(0, Number(this.timeStepMinutes) || 0);
        const numTimeSteps = Math.max(1, Math.round(Number(this.numTimeSteps) || 1));

        // EL Step 0 -> single elevation at EL Start (skip the 90° cap row).
        const elValues = [];
        if (elStep === 0) {
            elValues.push(elStart);
        } else {
            for (let el = elStart; el <= 90 + 1e-6; el += elStep) {
                elValues.push(Math.min(90, el));
            }
            if (elValues.length === 0 || elValues[elValues.length - 1] < 90) elValues.push(90);
        }

        // AZ Step 0 -> single azimuth at AZ Start for each elevation.
        const sweepShots = [];
        for (const el of elValues) {
            if (el >= 90 - 1e-6 || azStep === 0) {
                sweepShots.push({az: azStart, el});
            } else {
                for (let i = 0; i < 360; i += azStep) {
                    sweepShots.push({az: (azStart + i) % 360, el});
                }
            }
        }

        const shots = [];
        for (let t = 0; t < numTimeSteps; t++) {
            for (const s of sweepShots) shots.push({t, az: s.az, el: s.el});
        }

        return {shots, sweepShots, numTimeSteps, timeStepMinutes};
    }

    // Enter orbit preview mode. Returns false if validation failed (caller
    // should bounce the checkbox back to off).
    _enterPreview() {
        if (this._previewState) return true; // already in preview

        const view = ViewMan.get("lookView", false);
        if (!view || !view.camera || !view.canvas) {
            alert("Look view is not available; cannot enter orbit preview.");
            return false;
        }

        const trackKey = this.trackToOrbit;
        const initialTarget = resolveTargetPosition(trackKey);
        if (!initialTarget) {
            if (trackKey && trackKey !== "fixedTarget") {
                alert("Track to Orbit '" + trackKey + "' was not found or has no position. "
                    + "Pick another track, or import it before previewing.");
            } else {
                alert("No target found. Orbit preview needs a 'fixedTarget', "
                    + "'targetObject', 'targetTrack', or 'targetSphere'.");
            }
            return false;
        }

        const camera = view.camera;
        const orbitMode = this.orbitMode;
        let initialDistance = 0;   // fixed-distance mode: constant slant range
        let fixedAltMeters = 0;    // fixed-altitude mode: target HAE (meters)
        if (orbitMode === "altitude") {
            fixedAltMeters = this._resolveFixedAltitude(camera);
            const targetAlt = altitudeHAE(initialTarget);
            if (!isFinite(fixedAltMeters) || fixedAltMeters <= targetAlt + 1) {
                alert("Orbit Altitude must be above the target's altitude "
                    + "(~" + Math.round(targetAlt) + " m HAE). Raise the Orbit Altitude, "
                    + "or turn on 'Use Current Camera Altitude' with the camera above the target.");
                return false;
            }
        } else {
            if (this.useCurrentDistance) {
                initialDistance = camera.position.distanceTo(initialTarget);
            } else if (this.orbitDistanceNode) {
                initialDistance = this.orbitDistanceNode.getValueFrame(0);
            } else {
                initialDistance = camera.position.distanceTo(initialTarget);
            }
            if (!isFinite(initialDistance) || initialDistance < 1e-6) {
                alert(this.useCurrentDistance
                    ? "Initial camera distance to target is zero or invalid; cannot orbit at that radius."
                    : "Orbit Distance is zero or invalid; raise it above zero.");
                return false;
            }
        }

        const {shots} = this._buildShotList();
        if (shots.length === 0) {
            alert("Orbit shot list is empty — check AZ/EL step settings.");
            return false;
        }

        // Snapshot everything we're about to clobber.
        const state = {
            view,
            camera,
            trackKey,
            orbitMode,
            initialDistance,
            fixedAltMeters,
            // Last distance that solved cleanly in altitude mode — reused if a
            // later shot's solve fails (e.g. a moving target rises above altMeters).
            lastGoodDistance: initialDistance || 0,
            // Camera pose / projection.
            savedPos: camera.position.clone(),
            savedQuat: camera.quaternion.clone(),
            savedUp: camera.up.clone(),
            savedFov: camera.fov,
            // View render hooks + controls.
            savedPreRender: view.preRenderFunction,
            savedPostRender: view.postRenderFunction,
            savedFocus: view.focusTrackName,
            savedTargetVec: view.controls?.target?.clone(),
            savedControlsEnabled: view.controls ? view.controls.enabled : undefined,
            // Frame state.
            savedFrames: Sit.frames,
            savedAFrame: Sit.aFrame,
            savedBFrame: Sit.bFrame,
            savedFrame: par._frame,
            // Time state.
            savedSitStartTime: Sit.startTime,
            baseStartDate: (GlobalDateTimeNode && GlobalDateTimeNode.dateStart)
                ? new Date(GlobalDateTimeNode.dateStart)
                : new Date(Sit.startTime),
            // Look-camera controller toggles we'll re-enable on exit.
            disabledControllers: [],
            // Slider styling we restore on exit.
            sliderDiv: null,
            savedSliderBg: null,
            sliderInput: null,
            savedAccentColor: null,
            // Last applied time step (so we only call recalculateCascade when t crosses).
            lastT: -1,
        };

        // Disable look-camera controllers, same as the export does, so nothing
        // re-applies a track-driven pose between our manual updates.
        const lookCameraNode = NodeMan.get("lookCamera", false);
        if (lookCameraNode && lookCameraNode.inputs) {
            for (const inputID in lookCameraNode.inputs) {
                const inp = lookCameraNode.inputs[inputID];
                if (inp && inp.isController && inp.enabled) {
                    state.disabledControllers.push(inp);
                    inp.enabled = false;
                }
            }
        }

        // preRenderFunction fires inside renderCanvas just before the camera
        // matrices are sampled — re-apply our orbit pose here so anything that
        // moved the camera during the node-update cascade (CNodeCamera.update's
        // altAdjust / applyGroundTrackSwitch, etc.) gets overridden right before
        // the GL pipeline reads camera.matrixWorld. Without this, moving the
        // fixedTarget would visibly flicker between our pose and whatever the
        // node update left behind.
        const noop = function () {};
        view.preRenderFunction = () => {
            const previewState = this._previewState;
            if (!previewState) return;
            const shots = previewState.lastShots || this._buildShotList().shots;
            const shotIdx = Math.max(0, Math.min(shots.length - 1, Math.round(par.frame)));
            this._applyPreviewCameraPose(shots[shotIdx]);
        };
        view.postRenderFunction = noop;
        view.focusTrackName = "default";
        if (view.controls) view.controls.enabled = false;

        // Apply FOV override if requested.
        if (!this.useCurrentFOV) {
            const fovDeg = Number(this.verticalFOV);
            if (isFinite(fovDeg) && fovDeg > 0) {
                camera.fov = Math.max(0.01, Math.min(179, fovDeg));
                camera.updateProjectionMatrix();
            }
        }

        // Repurpose the frame slider as an orbit-shot index.
        Sit.frames = shots.length;
        Sit.aFrame = 0;
        Sit.bFrame = shots.length - 1;
        par.frame = 0;

        // Tint the frame slider green to signal preview mode.
        const slider = NodeMan.get("FrameSlider", false);
        if (slider) {
            if (slider.sliderDiv) {
                state.sliderDiv = slider.sliderDiv;
                state.savedSliderBg = slider.sliderDiv.style.backgroundColor;
                slider.sliderDiv.style.backgroundColor = "#1a5d2a"; // dark green
            }
            if (slider.sliderInput) {
                state.sliderInput = slider.sliderInput;
                state.savedAccentColor = slider.sliderInput.style.accentColor;
                slider.sliderInput.style.accentColor = "#2ecc71"; // bright green track/thumb
            }
        }

        this._previewState = state;
        Globals.orbitPreviewApply = () => this._applyPreviewFrame();

        // Apply shot 0 immediately so the view jumps to the orbit start.
        this._applyPreviewFrame();
        setRenderOne(true);

        return true;
    }

    // Called every tick by updateFrame.js (via Globals.orbitPreviewApply).
    // par.frame is the orbit shot index; we position the camera and (when t
    // changes) advance the sitch time.
    _applyPreviewFrame() {
        const state = this._previewState;
        if (!state) return;

        // Live-rebuild so changes to AZ/EL/time controls take effect without
        // toggling preview off and on. Cache the result so preRenderFunction
        // can reuse it without rebuilding per view-render.
        const {shots, numTimeSteps, timeStepMinutes} = this._buildShotList();
        if (shots.length === 0) return;
        state.lastShots = shots;

        // Keep Sit.frames in sync if the user changed AZ/EL step counts.
        if (Sit.frames !== shots.length) {
            Sit.frames = shots.length;
            Sit.aFrame = 0;
            Sit.bFrame = shots.length - 1;
        }

        // Clamp the slider's current frame to the shot range.
        let shotIdx = Math.max(0, Math.min(shots.length - 1, Math.round(par.frame)));
        if (par.frame !== shotIdx) par.frame = shotIdx;

        const shot = shots[shotIdx];

        // Time step boundary: shift the sitch start date so dateNow lands on
        // the correct point in the time-step schedule. We pick a startDate
        // such that for the first shot of this time step, dateNow == base + t*step;
        // within the time step, dateNow naturally advances by 1/fps per shot.
        if (shot.t !== state.lastT) {
            state.lastT = shot.t;
            if (GlobalDateTimeNode) {
                const N = shots.length / numTimeSteps; // shots per sweep
                const stepSec = timeStepMinutes * 60;
                const fps = Sit.fps || 30;
                // First shot index of this time step = shot.t * N.
                // We want dateNow at that index to be base + t*stepSec.
                // dateNow = startDate + (firstIdx)/fps  ⇒
                // startDate = base + t*stepSec - (t*N)/fps.
                const newStart = new Date(
                    state.baseStartDate.getTime()
                    + shot.t * stepSec * 1000
                    - (shot.t * N / fps) * 1000
                );
                GlobalDateTimeNode.setStartDateTime(newStart, true);
                GlobalDateTimeNode.update(par.frame);
                GlobalDateTimeNode.recalculateCascade();
            }
        }

        // Apply camera pose for the current shot. Done in a separate method so
        // we can also call it from preRenderFunction — node updates between
        // updateFrame and the actual render (CNodeCamera.update applies
        // altAdjust and applyGroundTrackSwitch directly, ignoring our disabled
        // controllers) would otherwise clobber the pose we set here.
        this._applyPreviewCameraPose(shot);
    }

    _applyPreviewCameraPose(shot) {
        const state = this._previewState;
        if (!state || !shot) return;

        // Re-resolve target every call so the camera tracks a moving fixed
        // target / drag-edited target without needing a preview re-toggle.
        const target = resolveTargetPosition(state.trackKey);
        if (!target) return;

        const east = getLocalEastVector(target);
        const north = getLocalNorthVector(target);
        const up = getLocalUpVector(target);

        const azR = radians(shot.az);
        const elR = radians(shot.el);
        const cosE = Math.cos(elR);
        const sinE = Math.sin(elR);
        const sinA = Math.sin(azR);
        const cosA = Math.cos(azR);

        const dir = new Vector3()
            .addScaledVector(north, cosE * cosA)
            .addScaledVector(east, cosE * sinA)
            .addScaledVector(up, sinE);

        // Resolve the camera distance live each call so slider drags update the
        // preview. In distance mode "Use current camera distance" keeps the
        // enter-time snapshot (the camera has moved since, so "current" only
        // makes sense as that snapshot) while the manual branch reads the
        // slider every call. In altitude mode the distance is solved per shot.
        let distance;
        if (state.orbitMode === "altitude") {
            // Re-resolve altitude live so dragging Orbit Altitude updates the
            // preview, mirroring the Orbit Distance behavior below. Per-shot
            // distance varies because each elevation reaches the chosen HAE at
            // a different range.
            let altMeters = state.fixedAltMeters;
            if (!this.useCurrentAltitude && this.orbitAltitudeNode) {
                const v = this.orbitAltitudeNode.getValueFrame(0);
                if (isFinite(v)) altMeters = v;
            }
            const d = solveDistanceForHAE(target, dir, altMeters);
            if (d !== null && isFinite(d) && d > 1e-6) {
                distance = d;
                state.lastGoodDistance = d;
            } else if (state.lastGoodDistance > 1e-6) {
                distance = state.lastGoodDistance;
            } else {
                // No valid distance yet (e.g. Orbit Altitude dragged below the
                // target): leave the camera where it is rather than snap it to
                // ~1 m from the target. A later tick with a valid altitude moves it.
                return;
            }
        } else {
            distance = state.initialDistance;
            if (!this.useCurrentDistance && this.orbitDistanceNode) {
                const sliderMeters = this.orbitDistanceNode.getValueFrame(0);
                if (isFinite(sliderMeters) && sliderMeters > 1e-6) {
                    distance = sliderMeters;
                }
            }
        }

        const camera = state.camera;
        camera.position.copy(target).addScaledVector(dir, distance);
        camera.up.copy(up);
        camera.lookAt(target);
        camera.updateMatrix();
        camera.updateMatrixWorld(true);

        // Keep manual FOV pinned each call — any node could have nudged
        // camera.fov via match-video-aspect, fovOverride, etc.
        if (!this.useCurrentFOV) {
            const fovDeg = Number(this.verticalFOV);
            if (isFinite(fovDeg) && fovDeg > 0) {
                const clamped = Math.max(0.01, Math.min(179, fovDeg));
                if (camera.fov !== clamped) {
                    camera.fov = clamped;
                    camera.updateProjectionMatrix();
                }
            }
        }
    }

    // Exit orbit preview mode and restore everything captured at enter time.
    _exitPreview() {
        const state = this._previewState;
        if (!state) return;
        this._previewState = null;
        Globals.orbitPreviewApply = null;

        // Restore frame state first so any downstream cascade reads sane values.
        Sit.frames = state.savedFrames;
        Sit.aFrame = state.savedAFrame;
        Sit.bFrame = state.savedBFrame;
        par.frame = state.savedFrame;

        // Restore time. Only call setStartDateTime if we actually moved time.
        if (GlobalDateTimeNode && state.lastT !== -1) {
            GlobalDateTimeNode.setStartDateTime(state.baseStartDate, true);
            GlobalDateTimeNode.update(par.frame);
            GlobalDateTimeNode.recalculateCascade();
            Sit.startTime = state.savedSitStartTime;
        }

        // Restore look-camera controllers.
        for (const inp of state.disabledControllers) inp.enabled = true;

        // Restore render hooks and controls.
        const view = state.view;
        view.preRenderFunction = state.savedPreRender;
        view.postRenderFunction = state.savedPostRender;
        view.focusTrackName = state.savedFocus;
        if (view.controls) {
            if (state.savedTargetVec) view.controls.target.copy(state.savedTargetVec);
            view.controls.enabled = state.savedControlsEnabled !== false;
        }

        // Restore camera pose.
        const camera = state.camera;
        camera.position.copy(state.savedPos);
        camera.quaternion.copy(state.savedQuat);
        camera.up.copy(state.savedUp);
        camera.fov = state.savedFov;
        camera.updateProjectionMatrix();
        camera.updateMatrix();
        camera.updateMatrixWorld(true);

        // Restore slider styling.
        if (state.sliderDiv) {
            state.sliderDiv.style.backgroundColor = state.savedSliderBg || "#000000";
        }
        if (state.sliderInput) {
            state.sliderInput.style.accentColor = state.savedAccentColor || "";
        }

        setRenderOne(true);
    }

    // Run the orbit + capture loop. Optional opts:
    //   maxWidth — if set, output images are downscaled to at most this width.
    //   filenameSuffix — extra string injected into each image name (and the
    //       zip name in the no-folder-picker fallback).
    //   dirHandle — pre-picked output directory handle (the fullscreen variant
    //       picks before entering fullscreen). undefined = ask here; null =
    //       skip the picker and use the zip fallback.
    async exportImageSet(opts = {}) {
        const {maxWidth, filenameSuffix = "", dirHandle: dirHandleOpt} = opts;

        // Preview drives the camera/time per-tick. If it's on when the user
        // clicks Export, exit it first so the export's own snapshot/restore
        // can capture a clean pre-export state.
        if (this.orbitPreview) {
            this.orbitPreview = false;
            if (this.orbitPreviewController) this.orbitPreviewController.updateDisplay();
            this._exitPreview();
        }

        const view = ViewMan.get("lookView", false);
        if (!view || !view.camera || !view.canvas) {
            alert("Look view is not available; cannot export image set.");
            return;
        }

        const trackKey = this.trackToOrbit;
        const initialTarget = resolveTargetPosition(trackKey);
        if (!initialTarget) {
            if (trackKey && trackKey !== "fixedTarget") {
                alert("Track to Export '" + trackKey + "' was not found or has no position. "
                    + "Pick another track, or import it before exporting.");
            } else {
                alert("No target found. Image set export needs a 'fixedTarget', "
                    + "'targetObject', 'targetTrack', or 'targetSphere'.");
            }
            return;
        }

        const camera = view.camera;
        const orbitMode = this.orbitMode;
        let initialDistance = 0;   // fixed-distance mode: constant slant range
        let fixedAltMeters = 0;    // fixed-altitude mode: target HAE (meters)
        if (orbitMode === "altitude") {
            fixedAltMeters = this._resolveFixedAltitude(camera);
            const targetAlt = altitudeHAE(initialTarget);
            if (!isFinite(fixedAltMeters) || fixedAltMeters <= targetAlt + 1) {
                alert("Orbit Altitude must be above the target's altitude "
                    + "(~" + Math.round(targetAlt) + " m HAE). Raise the Orbit Altitude, "
                    + "or turn on 'Use Current Camera Altitude' with the camera above the target.");
                return;
            }
        } else {
            if (this.useCurrentDistance) {
                initialDistance = camera.position.distanceTo(initialTarget);
            } else if (this.orbitDistanceNode) {
                // getValueFrame returns the slider value converted to SI meters.
                initialDistance = this.orbitDistanceNode.getValueFrame(0);
            } else {
                initialDistance = camera.position.distanceTo(initialTarget);
            }
            if (!isFinite(initialDistance) || initialDistance < 1e-6) {
                alert(this.useCurrentDistance
                    ? "Initial camera distance to target is zero or invalid; cannot orbit at that radius."
                    : "Orbit Distance is zero or invalid; raise it above zero.");
                return;
            }
        }

        // EL sweeps from elStart (0 = horizontal, 80 = nearly straight down)
        // up to 90 (straight down — camera directly above target). At el=90
        // every azimuth produces the same image so the sweep collapses to a
        // single shot. Shared with the orbit preview path.
        const {shots, numTimeSteps, timeStepMinutes} = this._buildShotList();

        // Ask for the output folder up front — after validation (so a doomed
        // export doesn't prompt) but before any camera/time state is touched,
        // while the button click's user activation is still valid. A cancel
        // aborts with nothing to restore.
        let dirHandle = dirHandleOpt;
        if (dirHandle === undefined) {
            dirHandle = await pickImageSetOutputFolder();
        }
        if (dirHandle === false) return; // user cancelled the folder picker

        // Save everything we're about to clobber.
        const savedPos = camera.position.clone();
        const savedQuat = camera.quaternion.clone();
        const savedUp = camera.up.clone();
        const savedFov = camera.fov;
        const savedTargetVec = view.controls?.target?.clone();
        const savedPreRender = view.preRenderFunction;
        const savedPostRender = view.postRenderFunction;
        const savedFocus = view.focusTrackName;
        const savedControlsEnabled = view.controls ? view.controls.enabled : undefined;
        const savedPaused = par.paused;

        // Snapshot the sitch start time so we can restore after time-stepping.
        // We capture both the ISO string and the actual Date the DateTime node
        // currently holds — they can differ briefly during populate().
        const savedSitStartTime = Sit.startTime;
        const baseStartDate = (GlobalDateTimeNode && GlobalDateTimeNode.dateStart)
            ? new Date(GlobalDateTimeNode.dateStart)
            : new Date(Sit.startTime);

        // Find the CNodeCamera that owns this Three.js camera and disable its
        // controllers — otherwise CNode3D.update() re-applies things like
        // CNodeControllerTrackPosition / PTZUI every frame and snaps the
        // camera back to its track-driven pose between our renders.
        const lookCameraNode = NodeMan.get("lookCamera", false);
        const disabledControllers = [];
        if (lookCameraNode && lookCameraNode.inputs) {
            for (const inputID in lookCameraNode.inputs) {
                const inp = lookCameraNode.inputs[inputID];
                if (inp && inp.isController && inp.enabled) {
                    disabledControllers.push(inp);
                    inp.enabled = false;
                }
            }
        }

        // Neutralize anything that would overwrite the camera each render:
        //  - preRender/postRender hooks (jet sitches reposition the camera onto the ball)
        //  - the focusTrackName block in CNodeView3D.renderCanvas (calls camera.lookAt)
        //  - orbit controls (read-only during export anyway, but explicit is safer)
        const noop = function () {};
        view.preRenderFunction = noop;
        view.postRenderFunction = noop;
        view.focusTrackName = "default";
        if (view.controls) view.controls.enabled = false;
        par.paused = true;

        // Lock the camera FOV for the orbit. With FOV controllers disabled
        // above, setting camera.fov once sticks across every renderCanvas
        // call (CNodeView3D snapshots/restores around its fovOverride, which
        // is itself derived from camera.fov — so the override chain rebuilds
        // from this value rather than fighting it).
        if (!this.useCurrentFOV) {
            const fovDeg = Number(this.verticalFOV);
            if (isFinite(fovDeg) && fovDeg > 0) {
                camera.fov = Math.max(0.01, Math.min(179, fovDeg));
                camera.updateProjectionMatrix();
            }
        }

        const progress = new ExportProgressWidget("Exporting image set...", shots.length);
        // The zip is only the fallback for environments with no folder picker.
        let zip = null;
        if (!dirHandle) {
            const {default: JSZip} = await import("jszip");
            zip = new JSZip();
        }
        const prefix = getExportPrefix();

        const fmtAz = (az) => String(Math.round(az)).padStart(3, "0");
        const fmtEl = (el) => (el >= 0 ? "p" : "n") + String(Math.abs(Math.round(el))).padStart(2, "0");
        const tDigits = String(Math.max(1, numTimeSteps - 1)).length;
        const fmtT = (t) => String(t).padStart(Math.max(2, tDigits), "0");

        // Per-time-step state: when t changes we advance the sitch start time
        // and re-resolve the target (the chosen track may move with time).
        let currentT = -1;
        let target = initialTarget.clone();
        let distance = initialDistance;
        // Fixed-altitude state: last distance that solved cleanly (0 until the
        // first solve in altitude mode), plus a count of shots that couldn't
        // reach the chosen HAE (target rose above it) so we can warn at the end.
        let lastGoodDistance = orbitMode === "altitude" ? 0 : initialDistance;
        let altitudeFallbackCount = 0;
        let east = getLocalEastVector(target);
        let north = getLocalNorthVector(target);
        let up = getLocalUpVector(target);

        let savedCount = 0;
        try {
            for (let i = 0; i < shots.length; i++) {
                if (progress.shouldStop()) break;

                const {t, az, el} = shots[i];

                // Advance time on the first shot of each new time step.
                if (t !== currentT) {
                    currentT = t;
                    if (GlobalDateTimeNode && timeStepMinutes > 0) {
                        const newStart = new Date(baseStartDate.getTime() + t * timeStepMinutes * 60_000);
                        GlobalDateTimeNode.setStartDateTime(newStart, true);
                        GlobalDateTimeNode.update(par.frame);
                        // setStartDateTime/populate doesn't trigger downstream
                        // recalculation on its own — date-driven nodes like
                        // CNodeSatelliteTrack rebuild their arrays in
                        // recalculate(), and the existing UI date-change paths
                        // (CNodeDateTime.js:239,782) always cascade. Without
                        // this, satellite/sun-driven targets would read stale
                        // positions for every time step.
                        GlobalDateTimeNode.recalculateCascade();
                    }
                    // Re-resolve target since the chosen track may move with time.
                    const t2 = resolveTargetPosition(trackKey);
                    if (t2) {
                        target = t2;
                        east = getLocalEastVector(target);
                        north = getLocalNorthVector(target);
                        up = getLocalUpVector(target);
                        // Keep the orbit radius fixed to the initial distance so all
                        // time steps render at the same scale.
                        distance = initialDistance;
                    }
                }

                const azR = radians(az);
                const elR = radians(el);
                const cosE = Math.cos(elR);
                const sinE = Math.sin(elR);
                const sinA = Math.sin(azR);
                const cosA = Math.cos(azR);

                // Az measured from local north, increasing clockwise toward east.
                // Direction points FROM target TOWARD camera, so camera = target + dir*shotDistance.
                const dir = new Vector3()
                    .addScaledVector(north, cosE * cosA)
                    .addScaledVector(east, cosE * sinA)
                    .addScaledVector(up, sinE);

                // Distance for this shot. Fixed-distance mode uses the constant
                // `distance`; fixed-altitude mode solves the distance along `dir`
                // that lands the camera at the chosen HAE — which varies per
                // elevation step (and per target altitude across time steps).
                let shotDistance = distance;
                if (orbitMode === "altitude") {
                    const d = solveDistanceForHAE(target, dir, fixedAltMeters);
                    if (d !== null && isFinite(d) && d > 1e-6) {
                        shotDistance = d;
                        lastGoodDistance = d;
                    } else if (lastGoodDistance > 1e-6) {
                        // A (usually time-stepped) target has risen above the chosen
                        // altitude: reuse the last solved distance and flag it so the
                        // off-altitude frames aren't shipped silently.
                        shotDistance = lastGoodDistance;
                        altitudeFallbackCount++;
                    } else {
                        // No valid distance yet (target already above the altitude on
                        // this shot) — skip rather than render a degenerate close-up.
                        altitudeFallbackCount++;
                        continue;
                    }
                }

                // The render closure is invoked by waitForExportFrameSettled
                // *during* its wait loop so terrain/3D-tile traversal can make
                // progress with the camera in its final pose.
                const renderShot = async () => {
                    camera.position.copy(target).addScaledVector(dir, shotDistance);
                    camera.up.copy(up);
                    camera.lookAt(target);
                    camera.updateMatrix();
                    camera.updateMatrixWorld(true);
                    // V5 shadows: each shot is a near-instant pose change; the
                    // §3.8 angular/time throttle would happily skip a shadow
                    // update for tiny deltas. Force-fresh for every captured
                    // pose so exported images have correct shadows.
                    if (Globals.shadowsEnabled) {
                        forceShadowRefreshForExport(view);
                    }
                    view.renderCanvas(par.frame);
                };

                // Warm-up the 3D tile traversal at the new pose BEFORE we
                // ask waitForExportFrameSettled to check pending counts.
                //
                // Why: the first shot of a run is the largest camera jump
                // (from wherever the lookCamera was → orbit start). Tile
                // traversal updates its "missing tiles" queue during render,
                // but it can take a few frames for the streaming pipeline
                // to actually surface those as pendingTerrainTiles /
                // pending3DTiles. If we entered settle immediately after
                // one render, the first iteration could observe "no pending"
                // (queues still empty) and trip the stableChecks counter
                // before the missing-tile work was even visible — yielding
                // the foreground-cutout artifact we saw on shot 0.
                //
                // Three primed renders are enough to let the traversal
                // register and start downloads; subsequent shots barely
                // need it (their tile sets overlap heavily with the prior
                // shot) but eating ~50ms here keeps the loop uniform.
                await renderShot();
                for (let warmup = 0; warmup < 3; warmup++) {
                    await new Promise((r) => requestAnimationFrame(r));
                    await renderShot();
                }

                // Block until terrain map+elevation tiles, 3D tiles, video
                // decode, and the async-op registry all report no pending work.
                // Bumped stableChecks/postSettleRenders above defaults so
                // a transient "queues briefly empty between batches" tick
                // can't end the wait early.
                await waitForExportFrameSettled({
                    frame: par.frame,
                    viewIds: ["lookView"],
                    renderFrame: renderShot,
                    logPrefix: "Image set export",
                    stableChecks: 4,
                    postSettleRenders: 2,
                });

                const mimeType = this.usePNGs ? "image/png" : "image/jpeg";
                const ext = this.usePNGs ? "png" : "jpg";
                // JPEG quality 0.9 — high enough that compression artifacts are
                // hard to spot on terrain/sky-dominated shots, while still
                // ~10-15x smaller than equivalent PNG.
                const blob = await canvasToImageBlob(view.canvas, maxWidth, mimeType, 0.9);
                if (blob) {
                    const tPart = numTimeSteps > 1 ? `_t${fmtT(t)}` : "";
                    const name = `${prefix}${filenameSuffix}${tPart}_el${fmtEl(el)}_az${fmtAz(az)}.${ext}`;
                    if (dirHandle) {
                        // Write each image straight into the chosen folder as
                        // it is captured (overwriting any same-named file from
                        // a previous run — shot names are deterministic).
                        await saveFileToDirectory(blob, dirHandle, name);
                    } else {
                        const buf = await blob.arrayBuffer();
                        zip.file(name, buf);
                    }
                    savedCount++;
                }

                if (i % 4 === 0) {
                    progress.update(i + 1);
                    await new Promise((r) => setTimeout(r, 0));
                }
            }

            if (orbitMode === "altitude" && altitudeFallbackCount > 0) {
                console.warn(`Image set export: ${altitudeFallbackCount} shot(s) could not reach the requested altitude (the target rose above it); those shots were skipped or reused the last valid distance.`);
            }

            if (progress.shouldSave() && savedCount > 0) {
                if (dirHandle) {
                    // Images were written to the folder as they were captured;
                    // nothing left to collate.
                    console.log(`Image set export complete: ${savedCount} images written to "${dirHandle.name}"`);
                } else {
                    progress.setStatus("Building zip...");
                    const zipBlob = await zip.generateAsync(
                        {type: "blob"},
                        (meta) => progress.setStatus(`Zipping ${Math.round(meta.percent)}%`),
                    );
                    const ts = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
                    saveAs(zipBlob, `${prefix}_imageset${filenameSuffix}_${ts}.zip`);
                    console.log(`Image set export complete: ${savedCount} images`);
                }
            } else if (savedCount === 0) {
                alert("No images were captured.");
            } else {
                console.log("Image set export aborted by user");
            }
        } catch (e) {
            console.error("Image set export failed:", e);
            alert("Image set export failed: " + e.message);
        } finally {
            view.preRenderFunction = savedPreRender;
            view.postRenderFunction = savedPostRender;
            view.focusTrackName = savedFocus;
            for (const inp of disabledControllers) inp.enabled = true;
            camera.position.copy(savedPos);
            camera.quaternion.copy(savedQuat);
            camera.up.copy(savedUp);
            camera.fov = savedFov;
            camera.updateProjectionMatrix();
            if (view.controls) {
                if (savedTargetVec) view.controls.target.copy(savedTargetVec);
                view.controls.enabled = savedControlsEnabled !== false;
            }
            camera.updateMatrix();
            camera.updateMatrixWorld(true);
            par.paused = savedPaused;

            // Restore the sitch start time. setStartDateTime rewrites
            // Sit.startTime via populate(), so we additionally pin
            // Sit.startTime back to its original string to keep deserialization
            // / save-state stable. recalculateCascade pulls date-driven nodes
            // (e.g. CNodeSatelliteTrack) back to their original-time arrays so
            // the post-export scene matches the pre-export scene.
            if (GlobalDateTimeNode && timeStepMinutes > 0 && numTimeSteps > 1) {
                GlobalDateTimeNode.setStartDateTime(baseStartDate, true);
                GlobalDateTimeNode.update(par.frame);
                GlobalDateTimeNode.recalculateCascade();
                Sit.startTime = savedSitStartTime;
            }

            progress.remove();
            setRenderOne(true);
        }
    }

    async exportImageSetFullscreen() {
        // Pick the output folder before entering fullscreen: the picker is an
        // OS-level dialog, and opening one from fullscreen kicks Chrome back
        // out of fullscreen (capturing frames at the wrong size). Chromium
        // re-grants user activation when the user confirms the picker, which
        // is what lets the requestFullscreen call below still succeed.
        const dirHandle = await pickImageSetOutputFolder();
        if (dirHandle === false) return; // user cancelled the folder picker

        const {updateSize} = await import("./JetStuff");
        const {applyRenderPerformanceSettings} = await import("./CustomSupport");

        const uiWasVisible = !Globals.menuBar._hidden;

        // Snapshot every chrome element we are about to hide.
        const savedRenderScale = Globals.settings ? Globals.settings.renderScale : undefined;
        const savedShowAttribution = Globals.settings ? Globals.settings.showAttribution : undefined;

        // Compass + clock overlays live on lookView via well-known node IDs
        // declared in CommonSitch.js (compassLook) and SituationSetup.js (labelVideo).
        const compassLook = NodeMan.get("compassLook", false);
        const savedCompassVisible = compassLook?.visible;

        const labelVideo = NodeMan.get("labelVideo", false);
        const savedLabelVisible = labelVideo?.visible;

        let enteredFullscreen = false;

        try {
            if (uiWasVisible) {
                Globals.menuBar.toggleVisiblity();
            }

            // Same fullscreen-enter dance as VideoExporter.exportFullscreenViewportVideo,
            // hardened: requestFullscreen can be DENIED here, because transient
            // user activation may not survive the folder picker above — notably
            // in the desktop app, where the picker is an awaited Electron IPC
            // call, not a Chromium picker confirmation (which re-grants
            // activation). A denial fires no fullscreenchange event, only a
            // promise rejection — so listen for the rejection and back it with
            // a timeout, and carry on un-fullscreened at the current window
            // size rather than waiting forever with the UI already hidden.
            const fsRequest = openFullscreen();
            enteredFullscreen = await new Promise((resolve) => {
                let settled = false;
                let timer = null;
                const finish = (ok) => {
                    if (settled) return;
                    settled = true;
                    if (timer) clearTimeout(timer);
                    document.removeEventListener("fullscreenchange", handler);
                    document.removeEventListener("webkitfullscreenchange", handler);
                    if (ok) {
                        updateSize(true);
                        setTimeout(() => resolve(true), 100);
                    } else {
                        resolve(false);
                    }
                };
                const handler = () => finish(true);
                document.addEventListener("fullscreenchange", handler);
                document.addEventListener("webkitfullscreenchange", handler);
                if (fsRequest && typeof fsRequest.catch === "function") {
                    fsRequest.catch(() => finish(false));
                }
                // Safety net for engines whose requestFullscreen returns no
                // promise (older WebKit): settle from the actual state.
                timer = setTimeout(() => finish(isFullscreen()), 3000);
            });
            if (!enteredFullscreen) {
                console.warn("Image set export: fullscreen request was denied; exporting at the current window size instead.");
            }

            // Hide compass / clock overlays.
            if (compassLook && typeof compassLook.setVisible === "function") {
                compassLook.setVisible(false);
            } else if (compassLook) {
                compassLook.visible = false;
            }
            if (labelVideo && typeof labelVideo.setVisible === "function") {
                labelVideo.setVisible(false);
            } else if (labelVideo) {
                labelVideo.visible = false;
            }

            // Disable map attribution + push renderScale to native (1.0).
            if (Globals.settings) {
                Globals.settings.renderScale = 1;
                Globals.settings.showAttribution = false;
                applyRenderPerformanceSettings();
            }

            // Some sitches (e.g. SitAguadilla) gate the lookView's render canvas
            // off a `canvasResolution` GUIValue exposed in Effects > Resolution.
            // Push it to the screen width (capped at FULLSCREEN_MAX_WIDTH).
            const canvasResNode = NodeMan.get("canvasResolution", false);
            if (canvasResNode && typeof canvasResNode.setValue === "function") {
                this._savedCanvasRes = canvasResNode.value;
                const screenW = (window.screen?.width || window.innerWidth || 1920);
                canvasResNode.setValue(Math.min(FULLSCREEN_MAX_WIDTH, screenW));
            }

            // Let the next render reflect the new settings before we start the orbit.
            setRenderOne(true);
            await new Promise((r) => setTimeout(r, 100));

            await this.exportImageSet({
                maxWidth: FULLSCREEN_MAX_WIDTH,
                filenameSuffix: "_fs",
                dirHandle,
            });
        } finally {
            // Restore overlays.
            if (compassLook && savedCompassVisible !== undefined) {
                if (typeof compassLook.setVisible === "function") {
                    compassLook.setVisible(!!savedCompassVisible);
                } else {
                    compassLook.visible = savedCompassVisible;
                }
            }
            if (labelVideo && savedLabelVisible !== undefined) {
                if (typeof labelVideo.setVisible === "function") {
                    labelVideo.setVisible(!!savedLabelVisible);
                } else {
                    labelVideo.visible = savedLabelVisible;
                }
            }

            // Restore settings.
            if (Globals.settings) {
                if (savedRenderScale !== undefined) Globals.settings.renderScale = savedRenderScale;
                if (savedShowAttribution !== undefined) Globals.settings.showAttribution = savedShowAttribution;
                applyRenderPerformanceSettings();
            }

            const canvasResNode = NodeMan.get("canvasResolution", false);
            if (canvasResNode && this._savedCanvasRes !== undefined
                && typeof canvasResNode.setValue === "function") {
                canvasResNode.setValue(this._savedCanvasRes);
                this._savedCanvasRes = undefined;
            }

            if (enteredFullscreen) closeFullscreen();
            if (uiWasVisible) Globals.menuBar.toggleVisiblity();
            setRenderOne(true);
        }
    }
}
