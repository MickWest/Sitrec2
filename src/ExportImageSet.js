import {saveAs} from "file-saver";
import JSZip from "jszip";
import {Vector3} from "three";
import {GlobalDateTimeNode, Globals, NodeMan, setRenderOne, Sit} from "./Globals";
import {par} from "./par";
import {ViewMan} from "./CViewManager";
import {getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "./SphericalMath";
import {ExportProgressWidget, getExportPrefix, openFullscreen, closeFullscreen} from "./utils";
import {radians} from "./mathUtils";
import {targetSphere} from "./JetStuffVars";
import {waitForExportFrameSettled} from "./ExportFrameSettler";
import {forceShadowRefreshForExport} from "./nodes/CNodeView3D";
import {CNodeGUIValue} from "./nodes/CNodeGUIValue";

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

// Encode the source canvas as a PNG blob, downscaling to maxWidth if requested
// and the source is larger. Aspect ratio is preserved.
function canvasToPngBlob(canvas, maxWidth) {
    if (!maxWidth || canvas.width <= maxWidth) {
        return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
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
    return new Promise((resolve) => out.toBlob(resolve, "image/png"));
}

export class ImageSetExporter {
    constructor() {
        this.azStep = 45;
        this.elStep = 20;
        this.elStart = 10;
        this.trackToOrbit = "fixedTarget";
        this.timeStepMinutes = 120;
        this.numTimeSteps = 1;
        this.useCurrentDistance = true;
    }

    setupMenu(parentFolder) {
        const folder = parentFolder.addFolder("Orbit Image Set").close()
            .tooltip("Export a set of PNG images of the look view from az/el positions around the target, optionally stepping the sitch time forward between sweeps");

        // Track selector — options are rebuilt from targetTrackSwitch each time
        // the folder is opened so newly-imported KML/MISB tracks show up.
        this.trackController = folder.add(this, "trackToOrbit", buildTrackOptions(this.trackToOrbit))
            .name("Track to Orbit")
            .tooltip("Track whose position at the current frame is the orbit center. Drawn from the same list as the Target Track switch.");

        folder.add(this, "azStep", 5, 90, 5)
            .name("AZ Step (deg)")
            .tooltip("Azimuth step (5-90, multiples of 5). 360 / azStep images per elevation.");
        folder.add(this, "elStart", 0, 80, 1)
            .name("EL Start (deg)")
            .tooltip("Lowest elevation in the sweep (0-80). 0 = horizontal, higher values skip the most grazing angles.");
        folder.add(this, "elStep", 1, 90, 1)
            .name("EL Step (deg)")
            .tooltip("Elevation step (1-90). Sweeps from EL Start to 90 (straight down) inclusive.");
        // Orbit distance: a checkbox to use the current camera-to-target
        // distance, OR a manual distance slider in big units (NM / mi / km).
        this.useCurrentDistanceController = folder.add(this, "useCurrentDistance")
            .name("Use Current Camera Distance")
            .tooltip("If on, the orbit radius is the current distance from the look camera to the target. If off, use the Orbit Distance slider below.")
            .onChange((on) => {
                if (this.orbitDistanceNode?.guiEntry) {
                    if (on) this.orbitDistanceNode.guiEntry.hide();
                    else this.orbitDistanceNode.guiEntry.show();
                }
            });

        // Distance slider. unitType "big" means the slider displays NM/mi/km
        // depending on the user's units setting, and getValueFrame(0) returns
        // meters. The initial value is in big units (≈5 km / 5 mi / 5 NM).
        if (!NodeMan.exists("imageSetOrbitDistance")) {
            this.orbitDistanceNode = new CNodeGUIValue({
                id: "imageSetOrbitDistance",
                value: 5,
                start: 0.01,
                end: 100,
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
        // Initially hidden because useCurrentDistance defaults to true.
        if (this.orbitDistanceNode?.guiEntry) {
            this.orbitDistanceNode.guiEntry.hide();
        }

        folder.add(this, "timeStepMinutes", 0, 1440, 1)
            .name("Time Step (minutes)")
            .tooltip("Minutes to advance the sitch start time between successive sweeps. Ignored when Number of Time Steps is 1.");
        folder.add(this, "numTimeSteps", 1, 240, 1)
            .name("Number of Time Steps")
            .tooltip("How many time-stepped sweeps to render. Step 0 uses Sit.startTime; step N adds N * Time Step.");
        folder.add({
            run: () => this.exportImageSet(),
        }, "run").name("Export Image Set")
            .tooltip("Render the look view at every (time, el, az) and download as a zip");
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

    // Run the orbit + capture loop. Optional opts:
    //   maxWidth — if set, output PNGs are downscaled to at most this width.
    //   filenameSuffix — extra string injected into each PNG name and the zip name.
    async exportImageSet(opts = {}) {
        const {maxWidth, filenameSuffix = ""} = opts;

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
        let initialDistance;
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

        const azStep = Math.max(1, Math.round(this.azStep));
        const elStep = Math.max(1, Math.round(this.elStep));
        const elStart = Math.max(0, Math.min(80, Math.round(this.elStart)));
        const timeStepMinutes = Math.max(0, Number(this.timeStepMinutes) || 0);
        const numTimeSteps = Math.max(1, Math.round(Number(this.numTimeSteps) || 1));

        // Build the per-time (az, el) shot list.
        // EL sweeps from elStart (0 = horizontal, 80 = nearly straight down)
        // up to 90 (straight down — camera directly above target).
        // At el=90 every azimuth produces the same image so we collapse to a
        // single shot.
        const elValues = [];
        for (let el = elStart; el <= 90 + 1e-6; el += elStep) {
            elValues.push(Math.min(90, el));
        }
        if (elValues.length === 0 || elValues[elValues.length - 1] < 90) elValues.push(90);

        const sweepShots = [];
        for (const el of elValues) {
            if (el >= 90 - 1e-6) {
                sweepShots.push({az: 0, el});
            } else {
                for (let az = 0; az < 360; az += azStep) {
                    sweepShots.push({az, el});
                }
            }
        }

        // Full shot list across all time steps, in (time, el, az) order.
        const shots = [];
        for (let t = 0; t < numTimeSteps; t++) {
            for (const s of sweepShots) shots.push({t, az: s.az, el: s.el});
        }

        // Save everything we're about to clobber.
        const savedPos = camera.position.clone();
        const savedQuat = camera.quaternion.clone();
        const savedUp = camera.up.clone();
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

        const progress = new ExportProgressWidget("Exporting image set...", shots.length);
        const zip = new JSZip();
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
                // Direction points FROM target TOWARD camera, so camera = target + dir*distance.
                const dir = new Vector3()
                    .addScaledVector(north, cosE * cosA)
                    .addScaledVector(east, cosE * sinA)
                    .addScaledVector(up, sinE);

                // The render closure is invoked by waitForExportFrameSettled
                // *during* its wait loop so terrain/3D-tile traversal can make
                // progress with the camera in its final pose.
                const renderShot = async () => {
                    camera.position.copy(target).addScaledVector(dir, distance);
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

                const blob = await canvasToPngBlob(view.canvas, maxWidth);
                if (blob) {
                    const tPart = numTimeSteps > 1 ? `_t${fmtT(t)}` : "";
                    const name = `${prefix}${filenameSuffix}${tPart}_el${fmtEl(el)}_az${fmtAz(az)}.png`;
                    const buf = await blob.arrayBuffer();
                    zip.file(name, buf);
                    savedCount++;
                }

                if (i % 4 === 0) {
                    progress.update(i + 1);
                    await new Promise((r) => setTimeout(r, 0));
                }
            }

            if (progress.shouldSave() && savedCount > 0) {
                progress.setStatus("Building zip...");
                const zipBlob = await zip.generateAsync(
                    {type: "blob"},
                    (meta) => progress.setStatus(`Zipping ${Math.round(meta.percent)}%`),
                );
                const ts = new Date().toISOString().slice(0, 19).replace(/:/g, "-");
                saveAs(zipBlob, `${prefix}_imageset${filenameSuffix}_${ts}.zip`);
                console.log(`Image set export complete: ${savedCount} images`);
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

            // Same fullscreen-enter dance as VideoExporter.exportFullscreenViewportVideo.
            openFullscreen();
            enteredFullscreen = true;
            await new Promise((resolve) => {
                const handler = () => {
                    document.removeEventListener("fullscreenchange", handler);
                    document.removeEventListener("webkitfullscreenchange", handler);
                    updateSize(true);
                    setTimeout(resolve, 100);
                };
                document.addEventListener("fullscreenchange", handler);
                document.addEventListener("webkitfullscreenchange", handler);
            });

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
