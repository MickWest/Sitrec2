import {saveAs} from "file-saver";
import JSZip from "jszip";
import {Vector3} from "three";
import {Globals, NodeMan, setRenderOne} from "./Globals";
import {par} from "./par";
import {ViewMan} from "./CViewManager";
import {getLocalEastVector, getLocalNorthVector, getLocalUpVector} from "./SphericalMath";
import {ExportProgressWidget, getExportPrefix, openFullscreen, closeFullscreen} from "./utils";
import {radians} from "./mathUtils";
import {targetSphere} from "./JetStuffVars";
import {waitForExportFrameSettled} from "./ExportFrameSettler";
import {forceShadowRefreshForExport} from "./nodes/CNodeView3D";

// Max output width for the Fullscreen variant. Inputs wider than this are
// downscaled (preserving aspect) before PNG encoding.
const FULLSCREEN_MAX_WIDTH = 1920;

// Resolve a world-space point for the "target" the look camera should orbit.
// Order of preference matches existing patterns elsewhere in the codebase
// (CustomSupport.preRenderUpdate, CMotionAnalysisUI, CFileManagerParse).
function resolveTargetPosition() {
    const out = new Vector3();

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
        this.azStep = 10;
        this.elStep = 10;
        this.elStart = 10;
    }

    setupMenu(parentFolder) {
        const folder = parentFolder.addFolder("Image Set").close()
            .tooltip("Export a set of PNG images of the look view from az/el positions around the target");

        folder.add(this, "azStep", 1, 90, 1)
            .name("AZ Step (deg)")
            .tooltip("Azimuth step (1-90). 360 / azStep images per elevation.");
        folder.add(this, "elStart", 0, 80, 1)
            .name("EL Start (deg)")
            .tooltip("Lowest elevation in the sweep (0-80). 0 = horizontal, higher values skip the most grazing angles.");
        folder.add(this, "elStep", 1, 90, 1)
            .name("EL Step (deg)")
            .tooltip("Elevation step (1-90). Sweeps from EL Start to 90 (straight down) inclusive.");
        folder.add({
            run: () => this.exportImageSet(),
        }, "run").name("Export Image Set")
            .tooltip("Render the look view at every (az, el) and download as a zip");
        folder.add({
            runFs: () => this.exportImageSetFullscreen(),
        }, "runFs").name("Export Image Set (Fullscreen)")
            .tooltip(`Like Export Image Set, but enter fullscreen, hide UI/clock/compass/attribution, and render at native effect resolution (capped at ${FULLSCREEN_MAX_WIDTH}px wide)`);
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
        const target = resolveTargetPosition();
        if (!target) {
            alert("No target found. Image set export needs a 'targetObject', 'targetTrack', or 'targetSphere'.");
            return;
        }

        const camera = view.camera;
        const distance = camera.position.distanceTo(target);
        if (!isFinite(distance) || distance < 1e-6) {
            alert("Initial camera distance to target is zero or invalid; cannot orbit at that radius.");
            return;
        }

        // ENU basis at the target so az/el are referenced to local geographic up/north.
        const east = getLocalEastVector(target);
        const north = getLocalNorthVector(target);
        const up = getLocalUpVector(target);

        const azStep = Math.max(1, Math.round(this.azStep));
        const elStep = Math.max(1, Math.round(this.elStep));
        const elStart = Math.max(0, Math.min(80, Math.round(this.elStart)));

        // Build the (az, el) shot list.
        // EL sweeps from elStart (0 = horizontal, 80 = nearly straight down)
        // up to 90 (straight down — camera directly above target).
        // At el=90 every azimuth produces the same image so we collapse to a
        // single shot.
        const shots = [];
        const elValues = [];
        for (let el = elStart; el <= 90 + 1e-6; el += elStep) {
            elValues.push(Math.min(90, el));
        }
        if (elValues.length === 0 || elValues[elValues.length - 1] < 90) elValues.push(90);

        for (const el of elValues) {
            if (el >= 90 - 1e-6) {
                shots.push({az: 0, el});
            } else {
                for (let az = 0; az < 360; az += azStep) {
                    shots.push({az, el});
                }
            }
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

        let savedCount = 0;
        try {
            for (let i = 0; i < shots.length; i++) {
                if (progress.shouldStop()) break;

                const {az, el} = shots[i];
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
                    const name = `${prefix}${filenameSuffix}_el${fmtEl(el)}_az${fmtAz(az)}.png`;
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
