import {registerSurfaceInteraction} from "../SurfaceInteraction";
// Star Tracker: the app-facing layer over the pure Star Track pipeline.
//
// Everything the analysis actually does lives in StarDetect / StarMatch / StarSolve, which are
// pure and testable. This module owns only the parts that need the running app: reading decoded
// video frames, the menu, and the overlay drawn on the video view.
//
// The menu lives under Video, alongside the other motion-analysis tools.

import {FileManager, GlobalDateTimeNode, Globals, guiMenus, NodeMan, Sit, setRenderOne, UndoManager} from "../Globals";
import {getStarDirectionECEF} from "../CelestialMath";
import {CNodeController} from "../nodes/CNodeController";
import {CNodeArray} from "../nodes/CNodeArray";
import {SITREC_APP} from "../configUtils";
import {CVideoImageData} from "../CVideoImageData";
import {par} from "../par";
import {abFrameRange} from "../TraverseAnalysisData";
import {hideProgress, initProgress, updateProgress} from "../CProgressIndicator";

import {STAR_DETECT_DEFAULTS, calibrateDetection, chooseDetectionSigma, detectSources,
    rejectReason} from "./StarDetect";
import {applyTransform, invertTransform, solveFrameChain} from "./StarMatch";
import {STAR_SOLVE_DEFAULTS, solveStarField} from "./StarSolve";
import {STAR_CLUSTER_DEFAULTS, groupMovingClusters} from "./StarCluster";
import {calibrateLens} from "./StarCalibrate";
import {
    attachRays, classifyTracksSpherical, gnomonicChart, statesFromChain2D,
    refineFixedAxisSpherical, tangentBasis,
} from "./StarSolveSphere";
import {refineGlobalSphericalAsync} from "./StarSphereSolvePool";
import {detectInPool, detectWorkersAvailable, ensureDetectPool, terminateDetectWorkers}
    from "./StarDetectPool";
import {framePixelToFrame, frameToRef, refToFrame, qConj, qMul, qRotate} from "./StarSphere";
import {LENS_PRESETS, lensFOV, lensToRay, rayToPixel, serializeLens} from "../CameraLens";
import {applyFisheyeState, clampFisheyeFov, fisheye, fisheyeStarLens} from "../FisheyeProjection";
import {fitLensToCatalog, matchCatalogToPixels, rankLensTypes} from "./StarLensFromCatalog";
import {
    STAR_IDENTIFY_DEFAULTS,
    buildQuadIndex,
    certifySolve,
    chartSpansBeyondFrame,
    parseStarCatalog,
    parseStarNames,
    raDecToVec,
    scalePriorFromFov,
    solveField,
    solveFieldWindowed,
    vecToRaDec,
    windowVfovDegAt,
} from "./StarIdentify";

let folder = null;
let overlay = null;
let overlayCtx = null;
let result = null;          // the last completed solve
let running = false;
let aborted = false;
// "Enough": stop scanning frames and solve what has already been measured. Deliberately NOT
// part of ctx.stale() - staleness means the run's answer is worthless and must be discarded,
// whereas this run's answer is simply drawn from a shorter clip than was asked for.
let enough = false;
// Live preview during the detect pass: the accepted detections of the frame just measured, in
// that run's analysed-video pixels, as {frame, sources, W, H}. Null whenever no run is scanning.
//
// Held separately from `result` rather than being folded into it, because at this point in a run
// nothing has been solved - there is no map, no classification and no magnitude tiering - and a
// re-analysis still has the PREVIOUS result sitting in `result`, describing a different pass.
let liveDetections = null;
// The best verified quads from the last identification, in reference-chart coordinates, as
// {points, mirrored, matched, nImage, fraction}. Kept AFTER the search finishes rather than
// cleared with it: on a good map identification takes under a tenth of a second, so anything
// shown only during the search is invisible - the evidence has to outlive the search to be worth
// drawing at all. Replaced when the next identify starts, and dropped with the solve on Clear.
let liveQuads = [];
// Kept by QUALITY, not recency: these persist, so they are a summary of what the solve found
// rather than a view of it working, and the five that explain the most of the field are the
// five worth leaving on screen.
const MAX_LIVE_QUADS = 5;
// The solve stage currently running, for the stages that are ONE GLOBAL OPTIMISATION over the
// whole clip rather than a walk through frames. Those have no "frame N of M" to report - every
// frame is being solved at once - so what is shown instead is the thing each stage is actually
// computing: for the lens, where it currently believes the optical axis is; for the spherical
// solve, the residual it is minimising, falling per iteration.
//   {kind: "lens", principal, size, rms, within, pairs, focalPx, type, stage}
//   {kind: "sphere", title, iteration, iterations, phase, rms, history: number[]}
let liveStage = null;

/**
 * Record one spherical-refinement progress report for the overlay.
 *
 * The residual history is kept per PASS, not across the whole run: pass 2 re-solves on the stars
 * alone and starts from a different cost, so carrying pass 1's trace into it would draw a jump
 * that means nothing. A new title starts a new trace.
 */
function noteSphereProgress(title, p) {
    if (!params.showDuringAnalysis) return;
    const same = liveStage?.kind === "sphere" && liveStage.title === title;
    // The FIRST cost of this pass, kept so the display can show how far it has come. Per pass,
    // not per run: pass 2 re-solves on the stars alone and starts from a different cost, so
    // carrying pass 1's starting point into it would describe a distance never travelled.
    const first = same && Number.isFinite(liveStage.first) ? liveStage.first
        : (Number.isFinite(p.rms) ? p.rms : undefined);
    // Only the cost phase carries an rms; the phase notifications fire on entry, before the
    // iteration has produced one.
    liveStage = {kind: "sphere", title, iteration: p.iteration, iterations: p.iterations,
        phase: p.phase, first,
        rms: Number.isFinite(p.rms) ? p.rms : (same ? liveStage.rms : undefined),
        step: Number.isFinite(p.step) ? p.step : (same ? liveStage.step : undefined),
        tolerance: p.tolerance ?? (same ? liveStage.tolerance : undefined)};
    setRenderOne();
}
// Measured pixel-scale parameters from "Detect Star Size", applied to subsequent analyses.
// Null means the hand-tuned defaults, which were measured on the reference footage.
let calibration = null;
// The video the calibration was measured on. A same-sitch video swap (selectVideo) replaces
// videoData with no teardown, and a plate-scale measurement of one video says nothing about
// another - consumers drop the calibration when this no longer matches.
let calibrationVideoData = null;
let minAreaController = null;
let threshSigmaController = null;
// Whether params.minArea currently holds a MEASURED value rather than a user-chosen one - it
// must fall with the calibration it came from, or teardown leaves a half-calibrated set.
let minAreaCalibrated = false;
// Whether params.minArea was CHOSEN - hand-edited, or picked and verified by the adjustment
// optimizer - as opposed to measured or left at its default. Three states are needed, not two:
// an untouched default must still be calibrated by a chained Detect Star Size, a measured value
// may be re-measured freely, and a chosen one must survive until somebody asks for a measurement
// explicitly. Without this, pressing Optimize and then Full Analysis silently discarded the blob
// size the optimizer had just verified, and the analysis differed from the one it promised.
let minAreaChosen = false;
// Monotonic ticket for calibration runs: only the newest request may publish. Two clicks in
// quick succession race their decoder waits, and video-identity checks cannot see that - both
// requests belong to the same video, but the older result describes the wrong frame.
let calibrationRequest = 0;
// Whether a calibration is still awaiting its frame - so whoever CANCELS it can also clear the
// "measuring" status, which the cancelled request itself is no longer allowed to touch.
let calibrationPending = false;

const params = {
    // Detection
    threshSigma: STAR_DETECT_DEFAULTS.threshSigma,
    // Resolve threshSigma from the footage before each run (chooseDetectionSigma over a few
    // spread frames) instead of trusting the slider. Opt-in: the probe is a heuristic with
    // measured guards, not yet a default.
    autoSigma: false,
    minArea: STAR_DETECT_DEFAULTS.minArea,
    // Classification
    minObservations: STAR_SOLVE_DEFAULTS.minObservations,
    driftSignificance: STAR_SOLVE_DEFAULTS.driftSignificance,
    driftMinSigmas: STAR_SOLVE_DEFAULTS.driftMinSigmas,
    // Lens. On a wide-angle clip the 2D similarity sky model is biased at the frame edges - a
    // measured ~10-12 px on the reference clip, enough to report edge stars as movers. When this
    // is on, the lens is fitted from the star field and the classification is redone on the
    // sphere. The gate refuses to fit whenever the clip does not constrain a lens, so leaving it
    // on costs nothing on the narrow-field footage that was always fine.
    fitLens: true,
    lensStatus: "not run",
    // The camera did not move, turn or zoom: solve the whole clip's sky motion as ONE axis and
    // ONE rate (the Earth's) instead of an orientation per frame. Three unknowns for the clip
    // rather than three per frame, which is what makes a sparse, sub-pixel-per-frame allsky
    // timelapse solvable at all. Off by default: most footage is hand-held or panned.
    fixedCamera: false,
    // Display. Each of these gates ONE thing on the overlay, so any of them can be turned off
    // without taking a neighbour with it: the star circles, the catalog names beside them and
    // the solver's quad lines are three independent layers over the same stars.
    showStars: true,
    showStarNames: true,
    showQuadLines: true,
    showMoving: true,
    showClusters: true,
    showRejected: false,
    showDuringAnalysis: true,
    useMask: true,
    // Analyse the frame the user is LOOKING at, not the raw decode. Levels, curves, sharpen,
    // blur and the rest of Video Adjustments are what the footage looks like on screen, so an
    // analysis of the raw frame can report stars the user cannot see, or miss ones they can.
    // On by default: with no adjustments set this is a no-op, and when they ARE set the
    // adjusted frame is the honest thing to measure.
    applyAdjustments: true,
    chartTracks: true,
    status: "not run",
};

// ---------------------------------------------------------------------------------------------
// Star catalog, lazily
// ---------------------------------------------------------------------------------------------

// The catalog (2.5 MB) and names file are fetched only when Identify Stars is first pressed,
// and the quad index tiers are built only as the solve needs them - the same cached-promise
// shape EGM96Geoid uses, stable URLs so the browser's HTTP cache carries them across deploys.
const quadIndexes = [];
let catalogPromise = null;
let namesPromise = null;

// Both loaders follow the same discipline: the promise is ASSIGNED before the loader body can
// throw - an async function runs synchronously up to its first await, so a synchronous parse
// error in a "clear the cache" catch would fire before the assignment and then be overwritten
// by the rejected promise, poisoning every retry - and a failed load clears the cache BY
// IDENTITY, so it never clobbers a newer attempt.
function ensureStarCatalog() {
    if (catalogPromise) return catalogPromise;
    const p = (async () => {
        // A night-sky sitch has already fetched the catalog through FileManager; reuse those
        // bytes rather than downloading 2.5 MB again.
        let buffer = FileManager.get?.("BSC5", false);
        if (!buffer) {
            const resp = await fetch(SITREC_APP + "data/nightsky/sitrec_bsc_lite.bin");
            if (!resp.ok) throw new Error(`star catalog fetch failed: ${resp.status}`);
            buffer = await resp.arrayBuffer();
        }
        return parseStarCatalog(buffer);
    })();
    catalogPromise = p;
    p.catch(() => { if (catalogPromise === p) catalogPromise = null; });
    return p;
}

// Names are cached SEPARATELY from the catalog: they are an enrichment, so one failed attempt
// must neither fail the identification nor freeze "nameless" in as the permanent answer - the
// next Identify press simply tries the file again.
function ensureStarNames() {
    if (namesPromise) return namesPromise;
    const p = (async () => {
        let nameText = FileManager.get?.("IAUCSN", false);
        if (!nameText) {
            const resp = await fetch(SITREC_APP + "data/nightsky/IAU-CSN.txt");
            if (!resp.ok) throw new Error(`star names fetch failed: ${resp.status}`);
            nameText = await resp.text();
        }
        return parseStarNames(nameText);
    })();
    namesPromise = p;
    p.catch(() => { if (namesPromise === p) namesPromise = null; });
    return p;
}

async function ensureIdentifyData() {
    const catalog = await ensureStarCatalog();
    let names;
    try {
        names = await ensureStarNames();
    } catch (e) {
        names = new Map();      // nameless identifications are still identifications
    }
    return {catalog, names};
}

/**
 * Yield to the event loop - a real macrotask, not a microtask.
 *
 * `await` on an already-resolved promise queues a MICROTASK, which the browser drains before it
 * ever repaints or dispatches input. So on a warm decoder, where every frame is already cached and
 * the awaits inside frameImage resolve immediately, the whole detection pass runs as one
 * uninterrupted block: the progress bar never moves and the Abort button cannot be clicked until
 * it is over. setTimeout yields properly.
 */
function yieldToBrowser() {
    return new Promise((r) => setTimeout(r, 0));
}

/** The video view node, or null when the sitch has no video. */
function videoView() {
    return NodeMan.exists("video") ? NodeMan.get("video") : null;
}

/**
 * The video's own frame index for a global playhead frame.
 *
 * The frame mapping comes from the SNAPSHOT, not from live state. A view locked to the In point
 * maps the global frame to a source frame by subtracting Sit.aFrame, and reading that live means
 * dragging the In marker mid-run silently re-bases the mapping part-way through - the first half
 * of the clip analysed at one offset and the second half at another.
 */
function sourceFrameOf(ctx, globalFrame) {
    return ctx.lockToInFrame ? Math.max(0, globalFrame - ctx.aFrame) : globalFrame;
}

/**
 * The decoded image for a frame, waiting until the decoder has genuinely produced it.
 *
 * getImage() alone returns the nearest ALREADY-DECODED frame when the requested one is not ready,
 * so a not-yet-decoded frame silently masquerades as a duplicate of its predecessor - which the
 * matcher would read as the camera having stopped. Driving par.frame as well keeps the render loop
 * and this pass asking for the same frame, instead of the decoder thrashing between two.
 *
 * drivePlayhead=false decodes WITHOUT moving par.frame. The pipelined pass decodes ahead of the
 * frames it has finished measuring, and the playhead must stay on the finished frame the preview
 * is drawn for, not the decode frontier - the caller walks par.frame forward itself, keeping it
 * within the pipeline depth of the frontier so the render loop's cache window still covers both.
 */
async function frameImage(view, globalFrame, ctx, drivePlayhead = true) {
    const vd = view.videoData;
    if (drivePlayhead) par.frame = globalFrame;
    const f = sourceFrameOf(ctx, globalFrame);
    const cached = () => (typeof vd.isFrameCached === "function") ? vd.isFrameCached(f)
        : (typeof vd.isFrameLoaded === "function") ? vd.isFrameLoaded(f) : false;
    for (let tries = 0; tries < 10 && !cached(); tries++) {
        // Each wait can be six seconds, so ten of them is a minute of hanging on to `running`
        // after the sitch has already been replaced - during which Analyze silently does nothing.
        if (ctx.stale()) return null;
        if (vd.requestFrame) { try { vd.requestFrame(f); } catch (e) { /* request the GOP */ } }
        if (vd.waitForFrame) { try { await vd.waitForFrame(f, 6000); } catch (e) { /* ignore */ } }
    }
    if (!cached()) return null;
    return vd.getImage(f);
}

/**
 * Read one frame's RGBA pixels, or null. Shared by the analysis pass and the calibration.
 *
 * With ctx.applyAdjustments set, the pixels are the DISPLAYED frame rather than the raw decode.
 * The readback itself belongs to the video view, so that this and "Optimize For Star Tracking"
 * measure through one definition of "adjusted" rather than two that can drift apart.
 */
async function framePixels(view, globalFrame, ctx, drivePlayhead = true) {
    // Echo accumulates the PRECEDING frames, and getImage() purges outside a 30-frame window -
    // shorter than the 100 frames echo can be set to. renderCanvas widens that window by declaring
    // echoFramesNeeded, but only while the view is actually rendering, so the declaration is made
    // here too or a purged frame is silently skipped and the analysis measures a shorter echo than
    // the display shows. Declared BEFORE the decode below, which is what does the purging, and
    // only ever RAISED: lowering it would evict frames the video view still wants.
    if (ctx.applyAdjustments) {
        const wantEcho = (view.in.echoMin?.value || view.in.echoMax?.value)
            && (view.in.enableVideoEffects ? view.in.enableVideoEffects.v0 : true);
        const needed = wantEcho ? Math.round(view.in.echoFrames?.v0 ?? 10) : 0;
        if (needed > (view.videoData.echoFramesNeeded || 0)) view.videoData.echoFramesNeeded = needed;
    }

    const img = await frameImage(view, globalFrame, ctx, drivePlayhead);
    if (!img || !img.width) return null;
    // The SOURCE frame, matching what renderCanvas passes - the filter caches key on it, and a
    // global frame here would make an In-locked view re-filter every already-filtered frame.
    return view.getFramePixels(img, sourceFrameOf(ctx, globalFrame), !!ctx.applyAdjustments);
}

/**
 * The detection settings the analysis would run with right now, for a frame of W x H.
 *
 * Exported so "Optimize For Star Tracking" scores candidate adjustments with the SAME detector and
 * the SAME accept/reject policy the Star Tracker will later apply to them. Optimising against a
 * different threshold, blob gate or calibration would tune the picture for a detector that is never
 * going to look at it.
 */
export function starTrackerDetectOptions(W, H) {
    return {
        threshSigma: params.threshSigma,
        minArea: params.minArea,
        // The "too big to be a star" bound scales with sensor area, exactly as it does in the
        // analysis - the same expression, because a mismatch here is a silent disagreement about
        // which blobs count.
        maxArea: Math.round(STAR_DETECT_DEFAULTS.maxArea * Math.max(1, (W * H) / (1276 * 720))),
        ...(calibration ? {
            apertureRadius: calibration.apertureRadius,
            annulusInner: calibration.annulusInner,
            annulusOuter: calibration.annulusOuter,
        } : {}),
    };
}

/**
 * The video mask an analysis would apply right now, refreshed, or null when it would apply none.
 *
 * Exported for the same reason as starTrackerDetectOptions: scoring candidate adjustments against
 * detections the analysis is going to DISCARD tunes the picture for foliage and rooftops - exactly
 * the things the mask exists to keep out of the answer.
 */
export function starTrackerVideoMask() {
    const maskNode = params.useMask ? NodeMan.get("videoMask", false) : null;
    if (maskNode?.maskCanvas) maskNode.updateMaskImageData();
    return (maskNode?.maskCanvas && maskNode.maskImageData) ? maskNode : null;
}

/** Whether an analysis would measure the adjusted frame - reported by the adjustment optimizer. */
export function starTrackerAppliesAdjustments() {
    return !!params.applyAdjustments;
}

// The adjustment optimizer's menu builder, registered by StarAdjustOptimize at load.
//
// A registration hook rather than an import, because that module already imports THIS one for the
// detector settings, the mask and the identification score - importing it back would close a cycle,
// and the same shape is what CMotionAnalysisShared uses between its own two halves.
let starOptimizeMenuBuilder = null;

export function setStarOptimizeMenuBuilder(fn) {
    starOptimizeMenuBuilder = fn;
}

/**
 * Whether the detection threshold is re-derived from the footage before every analysis.
 *
 * The optimizer asks because a threshold it searched for would be overwritten by the next Full
 * Analysis, so with this on there is no point sweeping one - and every reason not to report one.
 */
export function starTrackerAutoSigma() {
    return !!params.autoSigma;
}

/**
 * The searchable detection tweaks, and a way to set them with the sliders following along.
 *
 * The snapshot carries minAreaCalibrated because that flag is the value's PROVENANCE - whether a
 * later Detect Star Size may overwrite it. Restoring a hand-edited minArea through a setter that
 * always marks it "measured" would quietly convert the user's own choice into something the app
 * feels free to discard, which is a strange thing for an Abort to do.
 */
export function getStarTrackerTweaks() {
    return {threshSigma: params.threshSigma, minArea: params.minArea,
        minAreaCalibrated, minAreaChosen};
}

export function setStarTrackerTweaks({threshSigma, minArea,
    minAreaCalibrated: calibrated, minAreaChosen: chosen}) {
    if (threshSigma !== undefined) {
        params.threshSigma = threshSigma;
        threshSigmaController?.updateDisplay();
    }
    if (minArea !== undefined) {
        params.minArea = minArea;
        // A searched value is a CHOICE, not a measurement: it was verified against the catalog,
        // and the chained Detect Star Size inside Full Analysis must leave it alone or the
        // analysis differs from the one the search just proved. A restore passes both flags back
        // and keeps whatever they were.
        minAreaCalibrated = calibrated ?? false;
        minAreaChosen = chosen ?? true;
        minAreaController?.updateDisplay();
    }
}

/**
 * Snapshot / restore the PUBLISHED analysis, for a tool that runs analyses of its own.
 *
 * The adjustment optimizer runs a dozen single-frame analyses to score candidates, and each one
 * replaces the result the overlay draws, the result Identify and Sync act on, and Globals'
 * published copy. Without this, pressing Optimize would silently demote a completed whole-clip
 * analysis to a one-frame one - and Abort, which promises the state you started with, could not
 * give it back.
 *
 * The camera is re-baked from the restored solve rather than left alone: a synced camera drives
 * from its bake, so restoring the result without the bake would leave the view pointing by one
 * analysis while the menu describes another.
 */
export function captureStarTrackerResult() {
    return {result, quads: liveQuads, status: params.status};
}

export function restoreStarTrackerResult(snapshot) {
    if (!snapshot) return;
    result = snapshot.result;
    liveQuads = snapshot.quads ?? [];
    Globals.starTrackerResult = snapshot.result ?? undefined;
    params.status = snapshot.status;
    const ctrl = NodeMan.get("starTrackCameraController", false);
    if (ctrl?.poseTrack && snapshot.result?.identify && ctrl.bakeFrom(snapshot.result)) {
        attachStarTrackCamera(ctrl, false);
    }
    setRenderOne();
}

/**
 * Run the pipeline on the CURRENT frame alone and report how well the sky identified.
 *
 * This is the objective the tweak search optimises, and it is deliberately the END of the pipeline
 * rather than the middle of it. Measured on the reference still: adjustments tuned purely for
 * detection quality lifted usable detections from 16 to 47 and drove identification from 8 stars to
 * ZERO - the extra detections have no catalog counterpart, so they are clutter in the quad search
 * and the identifier's anti-chance guard correctly threw the whole solve out. Counting detections
 * cannot see that happen. Counting identified stars cannot miss it.
 *
 * Returns matched-star count, with a sub-integer tie-break favouring the tighter fit, or 0 when the
 * identification failed or refused.
 */
export async function scoreStarTrackerIdentification() {
    const analysis = await runStarTracker({singleFrame: true, quiet: true});
    if (!analysis) return {score: 0, matched: 0, rmsPx: 0};
    await identifyStars({scoring: true});
    const solved = analysis.identify?.solved;
    if (!solved || !solved.matches) return {score: 0, matched: 0, rmsPx: 0};
    const rmsPx = solved.rmsPx ?? 0;
    // The tie-break stays well under one match: a better fit breaks a tie, it never outvotes a
    // star. rms is a few pixels at worst, so 0.01x it cannot reach 1.
    return {score: solved.matches.length - 0.01 * rmsPx, matched: solved.matches.length, rmsPx};
}

/**
 * Drop the calibration when it was measured on a DIFFERENT video than the one about to use it.
 *
 * Both the measured parameter set and the measured minArea fall together, exactly as they do in
 * disposeStarTracker and for the same reason: keeping one without the other hands the analysis a
 * half-calibrated mismatch - default apertures against a blob gate measured at some other
 * plate scale. A hand-edited minArea is a preference, not a measurement, and stays.
 */
function dropCalibrationForOtherVideo(videoData) {
    if (!calibration || calibrationVideoData === videoData) return;
    calibration = null;
    calibrationVideoData = null;
    if (minAreaCalibrated) {
        params.minArea = STAR_DETECT_DEFAULTS.minArea;
        minAreaCalibrated = false;
        if (minAreaController) minAreaController.updateDisplay();
    }
    // A blob size chosen for the PREVIOUS video is not a choice about this one, so it stops
    // shielding itself from measurement. The value itself stays, exactly as a hand-set one does.
    minAreaChosen = false;
}

/**
 * Measure the star blobs on the CURRENT frame and adopt the pixel-scale parameters they imply.
 *
 * The hand-tuned defaults assume the reference footage's resolution, zoom and exposure; on
 * anything else the same constants are wrong in proportion to the blob size. One measured frame
 * fixes that - see calibrateDetection for what is derived and why.
 *
 * Returns whether the CONTEXT the caller clicked in still stands: false when the sitch or video
 * changed during the decode wait, a newer calibration superseded this one, or there was nothing
 * to run against - true otherwise, including when the measurement itself failed (a failed
 * calibration keeps the previous parameters precisely so analysis remains runnable, so it must
 * not read as "stop"). The chained Full Analysis button gates on this; a false
 * that went unchecked would let a click's analysis and camera sync land on a video the user
 * swapped in AFTER clicking.
 */
export async function detectStarSize(opts = {}) {
    // opts.measure marks the button - an explicit "measure it for me", which overwrites the blob
    // size whatever its provenance. The Full Analysis chain calls this WITHOUT it, because there
    // the user asked to run an analysis with the settings they have, not to have one of them
    // silently re-derived.
    const measureRequested = !!opts.measure;
    const view = videoView();
    if (!view || !view.videoData || running) return false;
    const generation = Globals.loadGeneration;
    const videoData = view.videoData;
    // "Keeping previous calibration" below is only honest when the previous calibration
    // measured THIS video.
    dropCalibrationForOtherVideo(videoData);
    const ctx = {
        lockToInFrame: !!view.lockToInFrame,
        aFrame: Sit.aFrame ?? 0,
        applyAdjustments: !!params.applyAdjustments,
        stale: () => Globals.loadGeneration !== generation
            || videoView() !== view || view.videoData !== videoData,
    };
    const request = ++calibrationRequest;
    calibrationPending = true;
    try {
        params.status = "measuring current frame";
        const px = await framePixels(view, Math.round(par.frame), ctx);
        // The decode wait can outlive the sitch, and it can also outlive a NEWER calibration
        // click on the same video. After it, nothing here may touch state unless this is still
        // both the current video and the current request.
        if (ctx.stale() || request !== calibrationRequest) return false;
        if (!px) { params.status = "no decoded frame to measure"; return true; }

        let autoNote = "";
        if (params.autoSigma) {
            // Resolve the threshold from the footage itself: probe up to three spread frames
            // of the analysed range and take the median recommendation. Several frames
            // because any single one can be atypical (a cloud, a person, a flare); the
            // median so one bad probe cannot drag the pick. When every probe refuses (too
            // few blobs to read a plateau from), the slider's value stands - refusing to
            // guess IS the sparse guard.
            const [af, bf] = abFrameRange(Sit.frames, 1);
            const sigmas = [];
            for (const f of [...new Set([af, Math.round((af + bf) / 2), bf])]) {
                const ppx = await framePixels(view, f, ctx);
                if (ctx.stale() || request !== calibrationRequest) return false;
                if (!ppx) continue;
                const pick = chooseDetectionSigma(ppx.data, ppx.W, ppx.H);
                if (pick.ok) sigmas.push(pick.sigma);
            }
            if (sigmas.length) {
                sigmas.sort((x, y) => x - y);
                params.threshSigma = sigmas[sigmas.length >> 1];
                threshSigmaController?.updateDisplay?.();
                autoNote = `auto sigma ${params.threshSigma} (${sigmas.length} frames) - `;
            } else {
                autoNote = `auto sigma: unreadable frames, keeping ${params.threshSigma} - `;
            }
        }

        const cal = calibrateDetection(px.data, px.W, px.H, {threshSigma: params.threshSigma});
        if (!cal.ok) {
            // Keep whatever calibration exists. A failed measurement is not evidence the
            // previous one was wrong - and clearing it while params.minArea kept its measured
            // value would leave a half-calibrated, mismatched parameter set.
            params.status = `calibration failed: only ${cal.count} usable blobs on this frame`
                + (calibration ? "; keeping previous calibration" : "");
            return true;
        }
        calibration = cal;
        calibrationVideoData = videoData;
        // The apertures are always taken - they are pure measurement, and nothing chooses them.
        // The blob size is only taken when it is not somebody's deliberate choice, or when a
        // measurement was explicitly asked for.
        const takeMinArea = measureRequested || !minAreaChosen;
        if (takeMinArea) {
            params.minArea = cal.minArea;
            minAreaCalibrated = true;
            minAreaChosen = false;
            if (minAreaController) minAreaController.updateDisplay();
        }
        params.status = autoNote
            + `${cal.count} blobs, median ${cal.medianArea} px, r ~${cal.rPsf.toFixed(1)} px`
            + ` -> min area ${params.minArea}${takeMinArea ? "" : " (kept)"}`
            + `, aperture ${cal.apertureRadius}`;
        return true;
    } catch (e) {
        // The button fires this without awaiting it, so a throw anywhere above would otherwise
        // become an unhandled rejection with the status stuck at "measuring". Report it - but
        // only if this request still owns the status.
        if (request === calibrationRequest && !ctx.stale()) {
            params.status = `calibration failed: ${e?.message ?? e}`;
            // A throw with the context intact is a measurement failure like any other.
            return true;
        }
        return false;
    } finally {
        // EVERY exit clears the pending flag - stale returns and exceptions included - but
        // only while this is still the current request; a newer one owns the flag otherwise.
        if (request === calibrationRequest) calibrationPending = false;
    }
}

/**
 * Render the solved star map as a chart - just the stars, at their reference-frame positions,
 * sized by measured magnitude - and download it as a PNG.
 *
 * Positions come from the solved map, not from any single frame, so the chart shows each star
 * once, where it sits on the sky in frame-0 pixel coordinates, regardless of when it was
 * visible. Disk size follows the measured instrumental magnitude with the convention every
 * printed chart uses - radius shrinking linearly with magnitude - so relative brightness reads
 * correctly at a glance even though an instrumental scale has no absolute zero point. Movers,
 * artifacts and rejected tracks are exactly what a star chart leaves out.
 */
export function makeStarChart() {
    if (!result) {
        params.status = "no analysis to chart - run Analyze first";
        return;
    }
    const stars = result.solved.classified.filter((c) =>
        c.klass === "star" && c.position && Number.isFinite(c.magnitude));
    if (!stars.length) {
        params.status = "no stars to chart";
        return;
    }

    // The moving objects' tracks, drawn as paths across the same reference frame the stars
    // live in - a chart of what moved against what stayed. Off by a toggle for a stars-only
    // chart.
    const trackPaths = [];
    if (params.chartTracks) {
        for (const c of result.solved.classified) {
            if (c.klass !== "moving") continue;
            const t = result.solved.tracks[c.index];
            const pts = t.obs.filter((o) => Number.isFinite(o.rx)).map((o) => [o.rx, o.ry]);
            if (pts.length >= 2) trackPaths.push({pts, kind: "moving"});
        }
        for (const cl of result.clusters || []) {
            const pts = [];
            for (let f = cl.first; f <= cl.last; f += 2) pts.push(cl.at(f));
            // The stride skips the final frame on odd spans, and the arrowhead marks the
            // path's END - it must sit at the actual endpoint.
            if (pts.length && (cl.last - cl.first) % 2 !== 0) pts.push(cl.at(cl.last));
            if (pts.length >= 2) trackPaths.push({pts, kind: "cluster"});
        }
    }

    // Plain loops, not Math.min(...spread): a long clip's tracks contribute thousands of
    // points, and spreading them into an argument list overflows it.
    const MARGIN = 50;
    let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
    const grow = (x, y) => {
        if (x < bMinX) bMinX = x;
        if (x > bMaxX) bMaxX = x;
        if (y < bMinY) bMinY = y;
        if (y > bMaxY) bMaxY = y;
    };
    for (const c of stars) grow(c.position[0], c.position[1]);
    for (const tp of trackPaths) for (const [x, y] of tp.pts) grow(x, y);
    const x0 = Math.floor(bMinX) - MARGIN;
    const y0 = Math.floor(bMinY) - MARGIN;
    const fullW = Math.ceil(bMaxX) + MARGIN - x0;
    const fullH = Math.ceil(bMaxY) + MARGIN - y0;
    // The map's bounding box grows with the pan, without limit - a long clip can sweep the
    // reference frame across many thousands of pixels, and asking the browser for a canvas
    // that size gets an allocation failure or a freeze, not a PNG. Scale to fit a safe
    // dimension; positions and disk sizes scale together, so the chart is simply smaller.
    const MAX_DIM = 4096;
    const scale = Math.min(1, MAX_DIM / Math.max(fullW, fullH));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(fullW * scale));
    canvas.height = Math.max(1, Math.round(fullH * scale));
    const g = canvas.getContext("2d");
    if (!g) {
        params.status = "star chart failed: no canvas context";
        return;
    }
    g.fillStyle = "#000";
    g.fillRect(0, 0, canvas.width, canvas.height);

    let magMin = Infinity, magMax = -Infinity;
    for (const c of stars) {
        if (c.magnitude < magMin) magMin = c.magnitude;
        if (c.magnitude > magMax) magMax = c.magnitude;
    }
    for (const c of stars) {
        const t = magMax > magMin ? (magMax - c.magnitude) / (magMax - magMin) : 0.5;
        const r = (1.4 + t * 6.6) * Math.max(scale, 0.35);
        const px = (c.position[0] - x0) * scale, py = (c.position[1] - y0) * scale;
        // A soft halo around a solid core, so bright stars read as bright rather than merely
        // large - the closest a clean chart gets to how they look on the footage.
        const halo = g.createRadialGradient(px, py, r * 0.5, px, py, r * 2.2);
        halo.addColorStop(0, "rgba(255,255,255,0.9)");
        halo.addColorStop(0.5, "rgba(255,255,255,0.25)");
        halo.addColorStop(1, "rgba(255,255,255,0)");
        g.fillStyle = halo;
        g.beginPath();
        g.arc(px, py, r * 2.2, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = "#fff";
        g.beginPath();
        g.arc(px, py, r, 0, Math.PI * 2);
        g.fill();

        // When the field has been identified, the chart says which star is which - proper
        // names a touch larger and in white, fallback designations quiet grey.
        if (result.identify) {
            const id = result.identify.identified.get(c.index);
            if (id) {
                const base = Math.max(10, Math.round(11 * Math.max(scale, 0.35)));
                g.fillStyle = id.named ? "#fff" : "#8a8f96";
                g.font = `${id.named ? base + 1 : base}px sans-serif`;
                g.fillText(id.label, px + r + 4 * scale + 3, py + 4);
            }
        }
    }

    // Object tracks: a path with an arrowhead at its final position, so direction reads at a
    // glance. Movers solid red, cluster ensembles dashed orange - the overlay's colour code.
    for (const tp of trackPaths) {
        const pts = tp.pts.map(([x, y]) => [(x - x0) * scale, (y - y0) * scale]);
        g.strokeStyle = tp.kind === "moving" ? "#ff2a2a" : "#ff9500";
        g.lineWidth = Math.max(1, 1.5 * scale);
        g.setLineDash(tp.kind === "cluster" ? [6, 4] : []);
        g.beginPath();
        g.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) g.lineTo(pts[i][0], pts[i][1]);
        g.stroke();
        g.setLineDash([]);
        const [ex, ey] = pts[pts.length - 1];
        const [px1, py1] = pts[Math.max(0, pts.length - 2)];
        const ang = Math.atan2(ey - py1, ex - px1);
        const ah = Math.max(5, 8 * scale);
        g.beginPath();
        g.moveTo(ex, ey);
        g.lineTo(ex - ah * Math.cos(ang - 0.4), ey - ah * Math.sin(ang - 0.4));
        g.moveTo(ex, ey);
        g.lineTo(ex - ah * Math.cos(ang + 0.4), ey - ah * Math.sin(ang + 0.4));
        g.stroke();
    }

    canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = "star-chart.png";
        a.click();
        // Give the browser time to start the download before the URL goes away.
        setTimeout(() => URL.revokeObjectURL(a.href), 30000);
    }, "image/png");
    params.status = `star chart: ${stars.length} stars`;
}

// ---------------------------------------------------------------------------------------------
// Identification on the sphere: a gnomonic chart of the solved map
// ---------------------------------------------------------------------------------------------
//
// The identifier works on a flat chart - quads hashed with a planar-similarity code, verified
// against a gnomonic projection of the catalog - and on a normal clip the 2D reference chart is
// close enough to one. Through a KNOWN fisheye it is not: a 160-degree field has no plane, and
// the 2D chain that built that chart is wrong by tens of pixels across it. So when the lens came
// from the Fisheye render, the settled star DIRECTIONS are projected gnomonically about the
// camera's own axis, keeping only the central field a tangent plane can carry (the gnomonic
// scale is 1/cos^2(theta): 2x at 45 deg, 4x at 60), and that chart is what gets identified. The
// chart's scale is chosen so it is the size of the video frame, which keeps the identifier's
// pixel tolerances (fractions of the field width) at their tuned meaning.

const SPHERE_CHART_MAX_THETA_DEG = 35;
// A hand-matched render lens is right to a few percent, not to the identifier's usual half a
// percent of the field: the sphere solve does not care (each star's direction is free), the
// plate verification does. So the sphere chart is verified at a wider pixel tolerance; the
// identifier's chance gate still scales with the catalog density inside it.
const SPHERE_CHART_VERIFY_FRACTION = 0.012;

/** Direction -> chart pixel. Null past the chart's usable field. */
function sphereChartProject(chart, d) {
    const {centre, e1, e2, focalPx, offset, cosMax} = chart;
    const z = d[0] * centre[0] + d[1] * centre[1] + d[2] * centre[2];
    if (!(z > cosMax)) return null;
    const a = d[0] * e1[0] + d[1] * e1[1] + d[2] * e1[2];
    const b = d[0] * e2[0] + d[1] * e2[1] + d[2] * e2[2];
    return [focalPx * a / z + offset, focalPx * b / z + offset];
}

/** Chart pixel -> unit direction (the inverse of sphereChartProject). */
function sphereChartUnproject(chart, x, y) {
    const {centre, e1, e2, focalPx, offset} = chart;
    const a = (x - offset) / focalPx, b = (y - offset) / focalPx;
    const v = [
        centre[0] + a * e1[0] + b * e2[0],
        centre[1] + a * e1[1] + b * e2[1],
        centre[2] + a * e1[2] + b * e2[2],
    ];
    const n = Math.hypot(v[0], v[1], v[2]);
    return [v[0] / n, v[1] / n, v[2] / n];
}

/**
 * The identify input for a known-lens run: stars charted from the sphere, or null when this run
 * is not one (the 2D chart path stands). Verdicts here are the SPHERE's (`klass`), not the 2D
 * ones the normal path deliberately keeps - on a fisheye the 2D verdicts are the wrong ones.
 */
function sphereIdentifyChart(r, minIdentifyObs) {
    const li = r?.lensInfo;
    if (!li?.lens || li.lens.source !== "fisheye" || !li.states) return null;
    // The camera's own axis in the reference frame - the gauge pins frame f0 to the identity,
    // so this is simply +z; read through the lens anyway so a gauge change cannot silently
    // move it.
    const size = [r.videoW, r.videoH];
    const f0 = li.states.findIndex((st) => st);
    if (f0 < 0) return null;
    const centre = frameToRef(li.states[f0], li.lens, li.lens.principal[0], li.lens.principal[1], size)
        ?? [0, 0, 1];
    const {e1, e2} = tangentBasis(centre);
    const focalPx = r.videoW / 2 / Math.tan(SPHERE_CHART_MAX_THETA_DEG * Math.PI / 180);
    const chart = {centre, e1, e2, focalPx, offset: r.videoW / 2,
        cosMax: Math.cos(SPHERE_CHART_MAX_THETA_DEG * Math.PI / 180)};
    const stars = [];
    for (const c of r.solved.classified) {
        if (c.klass !== "star" || !Number.isFinite(c.magnitude)) continue;
        if (c.n < minIdentifyObs || r.disabledStars?.has(c.index)) continue;
        const track = r.solved.tracks[c.index];
        const p = track?.ref ? sphereChartProject(chart, track.ref) : null;
        if (!p) continue;
        stars.push({x: p[0], y: p[1], mag: c.magnitude, index: c.index,
            obsF: track.obs.map((o) => o.f), ...pointSourceStats(track)});
    }
    return {chart, stars, fovDeg: 2 * SPHERE_CHART_MAX_THETA_DEG};
}

/**
 * The camera pose for a sphere-charted identification: the optical axis and the camera's UP
 * through this frame's solved orientation, onto the chart, and through the plate solution to
 * the sky. Up is the render's roll undone - the lens carries no roll, the solved orientation
 * absorbed it, and the camera the sync drives will have the render put it back.
 */
function sphereChartPose(r, globalFrame) {
    const id = r.identify, li = r.lensInfo;
    const states = li?.states;
    if (!states || !id?.chart) return null;
    const i = Math.max(0, Math.min(states.length - 1, Math.round(globalFrame) - r.frame0));
    let st = states[i];
    if (!st) {
        // Hold the nearest solved frame, as the 2D path holds its nearest transform.
        for (let d = 1; d < states.length && !st; d++) st = states[i - d] ?? states[i + d];
        if (!st) return null;
    }
    const size = [r.videoW, r.videoH];
    const [px, py] = li.lens.principal;
    const up = Math.max(50, r.videoH * 0.1);
    const roll = (li.rollDeg ?? 0) * Math.PI / 180;
    // Camera-up appears on screen rotated by the render's roll (positive = counterclockwise),
    // so in pixel coordinates (y down) it is the (-sin, -cos) direction from the axis.
    const centreDir = frameToRef(st, li.lens, px, py, size);
    const aboveDir = frameToRef(st, li.lens, px - up * Math.sin(roll), py - up * Math.cos(roll), size);
    if (!centreDir || !aboveDir) return null;
    const c = sphereChartProject(id.chart, centreDir);
    const a = sphereChartProject(id.chart, aboveDir);
    if (!c || !a) return null;
    return {centre: id.solved.refToSky(c[0], c[1]), above: id.solved.refToSky(a[0], a[1])};
}

/**
 * Calibrate the render's fisheye lens from the identified stars.
 *
 * Starts from the identifier's matches (bright stars inside the sphere chart's central field),
 * fits focal + principal + orientation for the user's projection type, then projects the whole
 * verification catalog through that model and matches it to EVERY star track's frame-f0 pixel -
 * which reaches the rim, where the lens curve is actually decided - and refits, twice, with a
 * tightening gate. The other projections are scored on the final set so the Lens field can say
 * whether the chosen one is the footage's.
 *
 * Returns null when there is nothing to fit from; the sphere-chart pose then stands.
 */
function fitFisheyeLensFromCatalog(r, catalog, solved, stars) {
    const li = r.lensInfo;
    const states = li?.states;
    if (!li?.lens || !states) return null;
    const f0 = states.findIndex((st) => st);
    if (f0 < 0) return null;
    const size = [r.videoW, r.videoH];
    const pixelAt = (track) => {
        const o = track?.obs?.find((ob) => ob.f === f0);
        return o ? [o.x, o.y] : null;
    };
    const D2R = Math.PI / 180;
    const corr = [];
    for (const m of solved.matches) {
        const px = pixelAt(r.solved.tracks[stars[m.image]?.index]);
        if (!px) continue;
        corr.push({px, dir: raDecToVec(m.raDeg * D2R, m.decDeg * D2R)});
    }
    const opts = {type: li.lens.type, seedLens: li.lens};
    let fit = fitLensToCatalog(corr, size, opts);
    if (!fit) {
        console.log(`[StarTrack] catalog lens fit: not enough correspondences (${corr.length})`);
        return null;
    }
    // Widen to the whole frame: every sphere-verdict star's f0 pixel against the catalog
    // projected through the current model.
    const pixels = [];
    for (const c of r.solved.classified) {
        if (c.klass !== "star") continue;
        const px = pixelAt(r.solved.tracks[c.index]);
        if (px) pixels.push({px, index: c.index});
    }
    let matched = corr;
    for (const tol of [8, 5]) {
        const m = matchCatalogToPixels(fit.lens, fit.q, catalog, pixels, size,
            STAR_IDENTIFY_DEFAULTS.verifyMagLimit, tol);
        if (m.length < corr.length) break;
        const next = fitLensToCatalog(m, size, {...opts, seedLens: fit.lens, seedQ: fit.q});
        if (!next) break;
        fit = next; matched = m;
    }
    const ranked = rankLensTypes(matched, size, fit.lens, fit.q);
    const L = fit.lens;
    console.log(`[StarTrack] catalog lens fit (${L.type}): f ${L.focalPx.toFixed(1)} px `
        + `(render ${li.lens.focalPx.toFixed(1)}), principal (${L.principal[0].toFixed(1)}, `
        + `${L.principal[1].toFixed(1)}) (render ${li.lens.principal[0].toFixed(1)}, `
        + `${li.lens.principal[1].toFixed(1)}), rms ${fit.rms.toFixed(2)} px over ${fit.inliers}/${fit.n} `
        + `stars (${corr.length} from identify); projections: `
        + ranked.map((k) => `${k.type} ${k.rms.toFixed(2)}`).join(", "));
    const best = ranked[0];
    params.lensStatus += `; catalog fit f ${L.focalPx.toFixed(0)} px, rms ${fit.rms.toFixed(2)} px `
        + `over ${fit.inliers} stars`
        + (best && best.type !== L.type && best.rms < fit.rms * 0.7
            ? ` (${LENS_PRESETS[best.type].label} fits better: ${best.rms.toFixed(2)} px)` : "");
    return {lens: L, q: fit.q, rms: fit.rms, inliers: fit.inliers, n: fit.n, f0, ranked,
        fromIdentify: corr.length};
}

/**
 * The camera pose from the catalog-fitted lens: exact at frame f0 (the fit's own orientation),
 * carried to other frames by the sky solve's per-frame rotation relative to f0. Up is the
 * render's roll undone, as in sphereChartPose.
 */
function catalogFitPose(r, globalFrame) {
    const fit = r.lensFit, li = r.lensInfo;
    const states = li?.states;
    if (!fit || !states) return null;
    const i = Math.max(0, Math.min(states.length - 1, Math.round(globalFrame) - r.frame0));
    let st = states[i];
    if (!st) {
        for (let d = 1; d < states.length && !st; d++) st = states[i - d] ?? states[i + d];
        if (!st) return null;
    }
    const size = [r.videoW, r.videoH];
    const [px, py] = fit.lens.principal;
    const up = Math.max(50, r.videoH * 0.1);
    const roll = (li.rollDeg ?? 0) * Math.PI / 180;
    // sky -> camera at frame i: the fit's orientation at f0, then the solve's f0 -> i rotation
    // (the solve's reference frame IS frame f0's camera, pinned to the identity by its gauge).
    const qi = qMul(st.q, fit.q);
    const toSky = (rayPx) => {
        const ray = lensToRay(fit.lens, rayPx[0], rayPx[1], size);
        if (!ray) return null;
        const v = qRotate(qConj(qi), ray);
        const rd = vecToRaDec(v);
        return {raDeg: rd.ra * 180 / Math.PI, decDeg: rd.dec * 180 / Math.PI};
    };
    const centre = toSky([px, py]);
    const above = toSky([px - up * Math.sin(roll), py - up * Math.cos(roll)]);
    if (!centre || !above) return null;
    return {centre, above};
}

/**
 * Put the catalog-fitted lens into the Fisheye render: same projection, the drawn image circle
 * kept as the user measured it, and the circle's FIELD ANGLE and the centre offsets set from
 * the fit. Returns a description of the change, or null when there is nothing to apply.
 */
function applyFittedLensToFisheye(r) {
    const fit = r?.lensFit;
    if (!fit || !fisheye.enabled || !r.videoW || !r.videoH) return null;
    const L = fit.lens;
    const preset = LENS_PRESETS[L.type];
    if (!preset) return null;
    const W = r.videoW, H = r.videoH;
    const before = {fov: fisheye.fov, centerX: fisheye.centerX, centerY: fisheye.centerY};
    // The image circle is what the footage shows; its angular radius is what the lens says.
    const circleRadiusPx = (fisheye.circlePct / 100) * H / 2;
    const rho = circleRadiusPx / L.focalPx;
    const maxRho = preset.maxRho ?? Infinity;
    const thetaEdge = preset.theta(Math.min(rho, maxRho));
    fisheye.lensType = L.type;
    fisheye.fov = clampFisheyeFov(2 * thetaEdge * 180 / Math.PI);
    fisheye.centerX = (L.principal[0] - W / 2) / H * 100;
    fisheye.centerY = (H / 2 - L.principal[1]) / H * 100;
    applyFisheyeState();
    return {before, after: {fov: fisheye.fov, centerX: fisheye.centerX, centerY: fisheye.centerY}};
}

// ---------------------------------------------------------------------------------------------
// Sync Camera: drive the look camera through the star field
// ---------------------------------------------------------------------------------------------

/**
 * The camera's per-frame pose through the star field, as two SKY DIRECTIONS: where the frame's
 * centre points, and where a point directly above the centre points. Two directions define the
 * whole orientation - boresight and roll together - and sampling them numerically through the
 * per-frame transform and the identify calibration sidesteps every angle-convention question
 * (roll sign, mirroring, pole behaviour) that a formula would have to get right.
 *
 * Frames outside the analysed range hold the nearest solved pose, matching how the overlay
 * treats them.
 */
function starTrackPose(globalFrame) {
    const r = result;
    const id = r?.identify;
    if (!id?.solved?.refToSky || !r.videoW) return null;
    if (r.lensFit) return catalogFitPose(r, globalFrame);
    if (id.chart) return sphereChartPose(r, globalFrame);
    const transforms = r.solved.transforms;
    const i = Math.max(0, Math.min(transforms.length - 1, Math.round(globalFrame) - r.frame0));
    const T = transforms[i];
    if (!T) return null;
    const inv = invertTransform(T);
    if (!inv) return null;
    const cx = r.videoW / 2, cy = r.videoH / 2;
    const upOffset = Math.max(50, r.videoH * 0.1);
    const [rx0, ry0] = applyTransform(inv, cx, cy);
    const [rx1, ry1] = applyTransform(inv, cx, cy - upOffset);
    if (!id.windowed) {
        return {centre: id.solved.refToSky(rx0, ry0), above: id.solved.refToSky(rx1, ry1)};
    }

    // Windowed: each surviving window calibrates its own stretch of the chart, so the pose
    // comes from the window(s) covering THIS frame. In overlaps the two-point poses are
    // blended with triangular weights (distance to the window edge), which fades each model
    // in from zero - the camera path stays continuous across every window boundary.
    //
    // A frame no surviving window covers sits in a stretch whose drift was never calibrated.
    // Refusing it entirely was tried and punishes exactly the honest case: a clip whose
    // blurred middle broke the chart still deserves a camera that follows the calibrated
    // parts, so uncovered frames EXTRAPOLATE from the flanking calibrated windows instead -
    // weighted by proximity, pinned to the accurate models at both edges of the gap, and
    // disclosed as approximate by the Sync status. An interior gap whose two flanks disagree
    // by more than 5 degrees is a different animal (one of them is not the same sky) - that
    // still refuses rather than steering the camera through a fictitious average.
    const D2R = Math.PI / 180;
    let covering = id.windows
        .filter((w) => i >= w.w0 && i < w.w1)
        .map((w) => ({w, wt: Math.min(i - w.w0 + 1, w.w1 - i)}));
    if (!covering.length) {
        const flanks = [];
        let before = null, after = null;
        for (const w of id.windows) {
            if (w.w1 <= i && (!before || w.w1 > before.w1)) before = w;
            if (w.w0 > i && (!after || w.w0 < after.w0)) after = w;
        }
        if (before) flanks.push({w: before, wt: 1 / (i - before.w1 + 1)});
        if (after) flanks.push({w: after, wt: 1 / (after.w0 - i)});
        if (!flanks.length) return null;
        if (flanks.length === 2) {
            const c0d = flanks[0].w.solved.refToSky(rx0, ry0);
            const c1d = flanks[1].w.solved.refToSky(rx0, ry0);
            const v0 = raDecToVec(c0d.raDeg * D2R, c0d.decDeg * D2R);
            const v1 = raDecToVec(c1d.raDeg * D2R, c1d.decDeg * D2R);
            const dot = v0[0] * v1[0] + v0[1] * v1[1] + v0[2] * v1[2];
            if (dot < Math.cos(5 * D2R)) return null;
        }
        covering = flanks;
    }
    const sc = [0, 0, 0], sa = [0, 0, 0];
    for (const {w, wt} of covering) {
        const c = w.solved.refToSky(rx0, ry0);
        const a = w.solved.refToSky(rx1, ry1);
        const vc = raDecToVec(c.raDeg * D2R, c.decDeg * D2R);
        const va = raDecToVec(a.raDeg * D2R, a.decDeg * D2R);
        for (let k = 0; k < 3; k++) {
            sc[k] += wt * vc[k];
            sa[k] += wt * va[k];
        }
    }
    const nc = Math.hypot(...sc), na = Math.hypot(...sa);
    if (nc < 1e-9 || na < 1e-9) {
        // Near-cancelling blend means the windows disagree wildly at this frame - refuse
        // rather than emit the meaningless average.
        return null;
    }
    const toDeg = (v, n) => {
        const rd = vecToRaDec([v[0] / n, v[1] / n, v[2] / n]);
        return {raDeg: rd.ra * 180 / Math.PI, decDeg: rd.dec * 180 / Math.PI};
    };
    return {centre: toDeg(sc, nc), above: toDeg(sa, na)};
}

/**
 * A camera controller that orients the look camera along the star-field solve: boresight at
 * the identified sky position of each frame's centre, rolled so that the sky direction "above
 * centre" in the video is up in the camera. Orientation only - position, and FOV via its own
 * switch, stay under whatever else controls them.
 *
 * The pose is computed AT APPLY TIME from the current result and the frame's own instant, so
 * a changed start time or timezone re-points the camera without any cache to invalidate; and
 * the apply is idempotent - it rebuilds the orientation from scratch each call, never rotating
 * relative to whatever pose it found (CNode3D can run a controller chain many times per frame).
 */
class CNodeControllerStarTrack extends CNodeController {
    constructor(v) {
        super(v);
        // The BAKED pose track: four numbers per analysed frame - the sky position of the
        // frame's centre, and of a point above it - starting at frame0. See bakeFrom().
        this.frame0 = v.frame0 ?? 0;
        this.poseTrack = Array.isArray(v.poseTrack) ? v.poseTrack : null;
        this.vfovDeg = Number.isFinite(v.vfovDeg) ? v.vfovDeg : null;
        // Per-frame FOV, baked only for windowed solves (a zoom-during-pan clip has no single
        // plate scale). Same indexing as poseTrack; vfovDeg stays as the scalar fallback.
        this.vfovTrack = Array.isArray(v.vfovTrack) ? v.vfovTrack : null;
    }

    /**
     * Freeze the solve's per-frame pose into plain numbers.
     *
     * The camera track is baked at sync time rather than recomputed at apply time because it has
     * to OUTLIVE the solve. `starTrackPose` reads `result.identify.solved.refToSky`, which is a
     * closure over the plate solution - a function, not data - so the live path cannot be saved
     * and reloaded whatever is written next to it. Two sky directions per frame can, and they
     * are the whole of what the controller needs: boresight and roll together.
     *
     * Baking also removes a second dependency. Nothing has to be re-derived on load, so a saved
     * camera track keeps working across changes to the solver, the lens model or the identify
     * stage - at the price of being frozen, which is the right trade for a recorded result.
     *
     * Rounded to 5 decimal places of a degree (~36 milliarcseconds, far finer than the solve),
     * because full float precision would triple the saved size for digits that are noise.
     */
    bakeFrom(r) {
        const transforms = r?.solved?.transforms;
        if (!transforms || !transforms.length) return false;
        const track = [];
        for (let i = 0; i < transforms.length; i++) {
            const pose = starTrackPose(r.frame0 + i);
            if (!pose) return false;
            track.push(
                +pose.centre.raDeg.toFixed(5), +pose.centre.decDeg.toFixed(5),
                +pose.above.raDeg.toFixed(5), +pose.above.decDeg.toFixed(5),
            );
        }
        this.frame0 = r.frame0;
        this.poseTrack = track;
        // A sphere-charted solve's plate scale is the CHART's, not the video's, and the video's
        // field is the fisheye's own - which the render already has. No FOV is baked for it.
        this.vfovDeg = r.videoH && !r.identify.chart
            ? starTrackVfovDeg(r.identify.solved, r.videoH) : null;
        // A windowed solve carries one plate scale PER WINDOW, and on a zoom-during-pan clip
        // those genuinely differ - baking one window's constant would render the sky at the
        // wrong framing everywhere else. So the FOV is baked per frame, blended across window
        // overlaps with the same weights as the pose. Frames in an uncalibrated stretch (the
        // pose extrapolates there) take the NEAREST calibrated window's scale.
        if (r.identify.windowed && r.videoH) {
            const windows = r.identify.windows;
            const nearestVfov = (i) => {
                let best = null, bestD = Infinity;
                for (const w of windows) {
                    const d = i < w.w0 ? w.w0 - i : (i >= w.w1 ? i - w.w1 + 1 : 0);
                    if (d < bestD) { bestD = d; best = w; }
                }
                return 2 * Math.atan((Math.PI / 180 / best.solved.pxPerDeg) * r.videoH / 2)
                    * 180 / Math.PI;
            };
            this.vfovTrack = Array.from({length: transforms.length}, (_, i) =>
                +(windowVfovDegAt(windows, i, r.videoH) ?? nearestVfov(i)).toFixed(4));
        } else {
            this.vfovTrack = null;
        }
        return true;
    }

    /** The baked pose for a frame, holding the nearest one outside the analysed range - which
     * is how the overlay treats those frames too. */
    posesAt(globalFrame) {
        const track = this.poseTrack;
        if (!track || !track.length) return null;
        const count = track.length / 4;
        const i = Math.max(0, Math.min(count - 1, Math.round(globalFrame) - this.frame0)) * 4;
        return {
            centre: {raDeg: track[i], decDeg: track[i + 1]},
            above: {raDeg: track[i + 2], decDeg: track[i + 3]},
        };
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            frame0: this.frame0,
            poseTrack: this.poseTrack,
            vfovDeg: this.vfovDeg,
            vfovTrack: this.vfovTrack,
        };
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        if (Number.isFinite(v.frame0)) this.frame0 = v.frame0;
        if (Array.isArray(v.poseTrack)) this.poseTrack = v.poseTrack;
        if (Number.isFinite(v.vfovDeg)) this.vfovDeg = v.vfovDeg;
        if (Array.isArray(v.vfovTrack)) this.vfovTrack = v.vfovTrack;
        // Put the "Star Track" entries back in the camera dropdowns. The switches restore their
        // own saved choice through CNodeSwitch's pendingChoice, which waits for the option to be
        // registered - so this is what lets a sitch saved with the camera synced come back
        // synced, rather than silently falling to Manual.
        if (this.poseTrack) attachStarTrackCamera(this);
    }

    apply(f, objectNode) {
        const pose = this.posesAt(f);
        if (!pose) return;
        const camera = objectNode.camera;
        const date = GlobalDateTimeNode.frameToDate(f);
        const D2R = Math.PI / 180;
        // The solve maps pixels to CATALOG RA/Dec, so recovering where the
        // camera was actually pointing needs the apparent (aberrated)
        // direction — the same one the star field is drawn at.
        const fwd = getStarDirectionECEF(
            pose.centre.raDeg * D2R, pose.centre.decDeg * D2R, date);
        const aboveDir = getStarDirectionECEF(
            pose.above.raDeg * D2R, pose.above.decDeg * D2R, date);
        // Up = the above-centre direction, orthogonalised against the boresight.
        const up = aboveDir.clone().sub(fwd.clone().multiplyScalar(fwd.dot(aboveDir)));
        if (up.lengthSq() < 1e-12) return;
        up.normalize();
        camera.up = up;
        camera.lookAt(camera.position.clone().add(fwd));
        objectNode.syncUIPosition?.();
    }
}

/** The constant vertical FOV the solve implies, in degrees: the fitted plate scale applied to
 * the frame height through the pinhole model. */
function starTrackVfovDeg(solvedIdentify, videoH) {
    const tanPerPx = (Math.PI / 180) / solvedIdentify.pxPerDeg;
    return 2 * Math.atan(tanPerPx * videoH / 2) * 180 / Math.PI;
}

// ---------------------------------------------------------------------------------------------
// The Camera menu's Lens folder
// ---------------------------------------------------------------------------------------------

/**
 * What the star field measured about the LENS, shown in the Camera menu where a lens belongs.
 *
 * Field of view alone does not describe a camera: it says how much sky the frame covers, not how
 * that sky is laid out across the pixels. Two cameras with the same 96-degree horizontal field
 * put a star 40 degrees off axis in completely different places if one is a pinhole and the other
 * a fisheye, and that difference is the whole reason the flat model called 70 real stars "moving".
 * So once the calibration has measured a lens, the measurement is worth showing next to the FOV
 * it qualifies - and it is the ONLY place in Sitrec where the pinhole assumption is ever lifted.
 *
 * Read-only by design. These are measurements, and a hand-edited focal length would silently
 * disagree with the classification, the chart and the sync that were computed from the fitted one.
 * (Letting the user assert a KNOWN lens and re-running the spherical pass under it is a real
 * feature, but it is that - a feature - not an editable text field.)
 */
const lensParams = {
    type: "-", focal: "-", principal: "-", offset: "-", distortion: "-",
    hfov: "-", vfov: "-", dfov: "-", fit: "-",
    copy: () => {
        const lens = result?.lensInfo?.lens;
        if (!lens) return;
        const text = JSON.stringify(serializeLens(lens), null, 2);
        // Reported on `status`, not `lensStatus`: lensStatus holds the fit summary for as long as
        // the fit stands, and a transient "copied!" would eat it until the next analysis.
        navigator.clipboard?.writeText(text)
            .then(() => { params.status = "lens JSON copied to clipboard"; })
            .catch(() => { console.log(text); params.status = "lens JSON logged to console"; });
    },
};
let lensControllers = [];

/**
 * Fill in (and reveal) the Camera > Lens folder from a completed calibration, or empty it when
 * there is no lens to describe.
 *
 * The folder is a permanent shell but its CONTROLS are not - menuBar.destroy(false) keeps the
 * folder and takes everything in it - so an existing controller list proves nothing about what is
 * on screen. The DOM is the authority, exactly as setupStarTrackerMenu treats its own folder.
 */
function updateCameraLensMenu(lensInfo, size) {
    const folder = guiMenus.cameraLens;
    if (!folder) return;

    // Drop whatever is there. On a sitch teardown the menu bar has already destroyed these, so
    // destroy() may be a second call on a dead controller - hence the guard.
    const clear = () => {
        for (const c of lensControllers) { try { c.destroy(); } catch { /* already gone */ } }
        lensControllers = [];
    };
    // An existing list is only trustworthy while its controls are still ON SCREEN.
    if (!lensControllers.length || !lensControllers[0].domElement?.isConnected) clear();

    if (!lensInfo?.lens) {
        clear();
        folder.hide();
        return;
    }

    const lens = lensInfo.lens;
    const fov = lensFOV(lens, size);
    const d3 = (v) => (v == null ? "-" : v.toFixed(3));
    lensParams.type = LENS_PRESETS[lens.type]?.label ?? lens.type;
    lensParams.focal = `${lens.focalPx.toFixed(1)} px`;
    // Kept short: the lil-gui value column truncates, and a clipped number is worse than a
    // slightly less precise one. The reference size it is measured in lives in the tooltip.
    lensParams.principal = `${lens.principal[0].toFixed(1)}, ${lens.principal[1].toFixed(1)} px`;
    // Where the optical axis sits RELATIVE to the frame centre, which is the number that says
    // whether the footage has been cropped, and how. A centred digital zoom leaves this at zero;
    // an uneven crop moves it by whatever was taken off one side, and a hard enough crop puts the
    // axis outside the frame entirely - a real, ordinary thing for cropped video, and the case
    // the fit's own bound cannot follow past.
    const [w, h] = lens.refSize;
    const ox = lens.principal[0] - w / 2, oy = lens.principal[1] - h / 2;
    const offFrame = lens.principal[0] < 0 || lens.principal[0] > w
        || lens.principal[1] < 0 || lens.principal[1] > h;
    lensParams.offset = `${ox >= 0 ? "+" : ""}${ox.toFixed(1)}, `
        + `${oy >= 0 ? "+" : ""}${oy.toFixed(1)} px `
        + `(${(100 * Math.abs(ox) / w).toFixed(1)}%, ${(100 * Math.abs(oy) / h).toFixed(1)}%)`
        + (offFrame ? " - OUTSIDE THE FRAME" : "")
        + (lensInfo.diagnostics?.principalClamped ? " - CLAMPED, may be cropped further" : "");
    // Only the custom curve has coefficients; for a named preset the shape IS the type.
    lensParams.distortion = lens.type === "custom"
        ? lens.distortion.map((v) => v.toFixed(3)).join(", ")
        : "(none - preset curve)";
    lensParams.hfov = fov ? `${d3(fov.hfov)} deg` : "-";
    lensParams.vfov = fov ? `${d3(fov.vfov)} deg` : "-";
    lensParams.dfov = fov ? `${d3(fov.dfov)} deg` : "-";
    lensParams.fit = `${lensInfo.rms.toFixed(2)} px rms`
        + (lensInfo.diagnostics?.holdoutRms != null
            ? `, ${lensInfo.diagnostics.holdoutRms.toFixed(2)} px held out` : "");

    if (!lensControllers.length) {
        const ro = (prop, name, tip) => {
            const c = folder.add(lensParams, prop).name(name).listen().disable();
            if (tip) c.tooltip(tip);
            lensControllers.push(c);
        };
        ro("type", "Type", "The curve mapping field angle to image radius. Fitted from the star "
            + "field by Star Track; everything else in Sitrec assumes a pinhole.");
        ro("focal", "Focal length", "In the pixels the analysis ran in, not the source video's - "
            + "see the reference size beside the principal point.");
        ro("principal", "Principal point", `Where the optical axis meets the image, in the pixels `
            + `the analysis ran in (${lens.refSize[0]}x${lens.refSize[1]}). On uncropped footage a `
            + `fitted one lands near the frame centre.`);
        ro("offset", "Axis off centre", "The signature of CROPPING. A centred digital zoom leaves "
            + "this near zero (the crop keeps the axis at the new centre, and the focal length is "
            + "measured in the analysed pixels either way). An UNEVEN crop moves it by whatever "
            + "was taken off one side, and a hard enough crop puts the axis outside the frame - "
            + "which is ordinary for cropped video, not an error. \"CLAMPED\" means the fit wanted "
            + "to move it further than the search is allowed to, so read the value as a floor.");
        ro("distortion", "Distortion (d3, d5, d7)",
            "theta = rho + d3 rho^3 + d5 rho^5 + d7 rho^7, with the linear term pinned to 1 so "
            + "the focal length alone sets the paraxial scale.");
        ro("hfov", "Horizontal FOV", "Measured across the full frame through the fitted curve, so "
            + "an off-centre principal point is accounted for rather than assumed away.");
        ro("vfov", "Vertical FOV");
        ro("dfov", "Diagonal FOV");
        ro("fit", "Fit residual", "How well one rotation through this lens explains the measured "
            + "star motion. The held-out figure is scored on correspondences the fit never saw, "
            + "which is the one that says whether it generalises.");
        lensControllers.push(folder.add(lensParams, "copy").name("Copy lens JSON"));
    }
    folder.show();
}

/**
 * Register the star-field camera in the Camera menu's Heading (and FOV) source dropdowns and
 * switch to it. The user can switch back to Manual - or anything else - in the Camera menu;
 * the option stays available until the analysis is cleared.
 */
/**
 * Build the Star Track camera controller node.
 *
 * Exported so CustomManagerSetup can create it up front, which it must: the node carries the
 * baked camera track in its own mod, and a mod is only ever applied to a node that already
 * exists. Kept here rather than there so the class stays private to this module.
 */
export function makeStarTrackCameraController(id) {
    return new CNodeControllerStarTrack({id});
}

/**
 * Register the Star Track entries in the camera dropdowns from a controller that already holds
 * a baked track, and select them.
 *
 * Shared by Sync Camera and by the controller's own modDeserialize, so a reloaded sitch takes
 * exactly the path a freshly synced one does - the alternative being a second, load-only copy
 * of this wiring that would drift from it.
 *
 * @param select when false the options are registered but not chosen, leaving the saved switch
 *               choices to decide - which is what a restore wants, since a sitch saved on
 *               Manual must come back on Manual even though a track is present.
 */
function attachStarTrackCamera(controller, select = false) {
    const lookCamera = NodeMan.get("lookCamera", false);
    const headingSwitch = NodeMan.get("CameraLOSController", false);
    if (!lookCamera || !headingSwitch) return false;

    // Controllers are attached as INPUTS (addControllerNode -> addInput), so that is where
    // "already attached" is asked. Attaching twice would run the pose twice per frame.
    if (!lookCamera.inputs[controller.id]) {
        lookCamera.addControllerNode(controller);
        // Tracking Wobble is attached at setup time; an absolute pose applied BEFORE it would
        // be wobbled, applied after it would wipe the wobble - keep wobble last.
        lookCamera.moveControllerToEnd?.("trackingWobbleController");
    }
    headingSwitch.replaceOption("Star Track", controller);
    if (select) headingSwitch.selectOption("Star Track");

    // The solve knows the zoom too: the vertical FOV from the fitted plate scale, selectable
    // alongside the heading so the rendered sky matches the video's framing. A windowed solve
    // baked one FOV PER FRAME (zoom can change mid-pan); otherwise the scalar fills the
    // timeline. Frames outside the analysed range hold the nearest baked value, exactly as
    // the pose does.
    const fovSwitch = NodeMan.get("fovSwitch", false);
    const vt = controller.vfovTrack;
    if (fovSwitch && (vt?.length || Number.isFinite(controller.vfovDeg))) {
        const fovArray = Array.from({length: Sit.frames}, (_, f) => (vt?.length
            ? vt[Math.max(0, Math.min(vt.length - 1, f - controller.frame0))]
            : controller.vfovDeg));
        let fovNode = NodeMan.get("starTrackFOV", false);
        if (fovNode) {
            fovNode.array = fovArray;
        } else {
            fovNode = new CNodeArray({id: "starTrackFOV", array: fovArray});
        }
        fovSwitch.replaceOption("Star Track", fovNode);
        if (select) fovSwitch.selectOption("Star Track");
    }
    return true;
}

export function syncCameraToStarTrack() {
    if (!result?.identify?.solved?.ok) {
        params.status = "run Analyze and Identify Stars first";
        return;
    }
    const controller = NodeMan.get("starTrackCameraController", false);
    if (!controller) {
        params.status = "no star track controller in this sitch";
        return;
    }
    // A fisheye run with a catalog lens fit syncs the LENS as well as the pose: the render's
    // FOV and centre are set from the stars, the projection type and the drawn circle kept.
    const lensChange = applyFittedLensToFisheye(result);
    // Bake BEFORE attaching: the controller drives the camera from its baked track, so
    // attaching one that is still empty would point the camera at nothing.
    if (!controller.bakeFrom(result)) {
        const id = result.identify;
        // Uncalibrated stretches are normally bridged by extrapolating the flanking windows;
        // the bake only refuses when even that is dishonest - the flanks disagree on the sky.
        params.status = id?.windowed && id.partial
            ? "identify calibrated frames "
                + id.covered.map(([a, b]) => `${result.frame0 + a}-${result.frame0 + b - 1}`)
                    .join(", ")
                + " only, and the calibrated stretches disagree - cannot bridge the gap"
            : "the solve has no per-frame transforms to sync to";
        return;
    }
    if (!attachStarTrackCamera(controller, true)) {
        params.status = "no look camera to sync in this sitch";
        return;
    }

    // Partial identify still syncs - the camera follows the calibrated stretches exactly and
    // the bridged frames approximately - but say which is which.
    params.status = result.identify?.windowed && result.identify.partial
        ? "camera synced - frames "
            + result.identify.covered
                .map(([a, b]) => `${result.frame0 + a}-${result.frame0 + b - 1}`).join(", ")
            + " calibrated, the rest approximate"
        : "camera synced to the star field"
            + (lensChange
                ? ` - fisheye FOV ${lensChange.before.fov.toFixed(1)} -> ${lensChange.after.fov.toFixed(1)} deg, `
                    + `centre (${lensChange.before.centerX.toFixed(1)}, ${lensChange.before.centerY.toFixed(1)}) -> `
                    + `(${lensChange.after.centerX.toFixed(1)}, ${lensChange.after.centerY.toFixed(1)}) %`
                : "");
    setRenderOne();
}

/** Take the Star Track options out of the camera dropdowns - BEFORE the solve they rest on
 * goes away, so the switches fall back to a valid choice rather than a dangling one. */
function detachStarTrackCamera() {
    NodeMan.get("CameraLOSController", false)?.removeOption?.("Star Track");
    NodeMan.get("fovSwitch", false)?.removeOption?.("Star Track");
    // The controller node itself stays attached to the camera across solves. removeOption only
    // stops the switch MANAGING its enabled flag - it does not clear it - and a stale
    // enabled=true would sit dormant while there is no solve, then silently override Manual
    // the moment a new analysis gives it data again.
    const ctrl = NodeMan.get("starTrackCameraController", false);
    if (ctrl) ctrl.enabled = false;
}

/**
 * Blind-identify the solved star map against the star catalog: no location, no time, no
 * pointing assumed - the field is found purely from the geometry of the stars themselves
 * (quad hashing; see StarIdentify). On success each confirmed star gains a name, and the
 * overlay and chart label them.
 */
/**
 * Point-source measurements for one track, medianed over its own detections.
 *
 * `peakSNR` is how far the blob's PEAK stands above the local noise, which is what separates a
 * star from lit foliage: a leaf clump is bright because it is large, so it carries a big
 * integrated flux with an unremarkable peak. `extent` and `elongation` say whether the blob is
 * the compact round shape a point source makes.
 *
 * Returns an empty object when the detector records are unavailable, so the caller simply omits
 * the fields and the solver falls back to ranking by brightness.
 */
function pointSourceStats(track) {
    const snr = [], extent = [], elongation = [];
    for (const o of track?.obs ?? []) {
        const s = o.src;
        if (!s) continue;
        if (Number.isFinite(s.peakSNR)) snr.push(s.peakSNR);
        if (Number.isFinite(s.width) && Number.isFinite(s.height)) {
            extent.push(Math.max(s.width, s.height));
        }
        if (Number.isFinite(s.elongation)) elongation.push(s.elongation);
    }
    const median = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : undefined);
    const out = {};
    if (snr.length) out.snr = median(snr);
    if (extent.length) out.extent = median(extent);
    if (elongation.length) out.elongation = median(elongation);
    return out;
}

export async function identifyStars(opts = {}) {
    // opts.scoring marks a run whose ONLY purpose is to produce a number for a search. It still
    // identifies - that is the number - but it must not steer the user's camera while doing it.
    const scoring = !!opts.scoring;
    if (!result) {
        params.status = "run Analyze first";
        return;
    }
    const myResult = result;
    const generation = myResult.generation;
    liveQuads = [];
    // Freshness includes the VIDEO's identity: replacing the video in the same view does not
    // change the result object or the generation, and an identification of the old sky must
    // not attach to (or report status over) the new one.
    const fresh = () => result === myResult
        && Globals.loadGeneration === generation
        && videoView()?.videoData === myResult.videoData;
    try {
        params.status = "loading star catalog";
        await yieldToBrowser();
        const {catalog, names} = await ensureIdentifyData();
        if (!fresh()) return;

        // Identify from the WELL-OBSERVED stars only. A long panning range tracks through
        // rough stretches (blur, weak fits) that break some tracks into short fragments, and
        // the pieces land displaced by the very registration error that broke them - so each
        // fragment enters the map as an extra "star" that no catalog position will ever match,
        // inflating the consensus denominator while contributing nothing to the numerator.
        // Span length is the discriminator: real anchor stars persist, fragments are short
        // BECAUSE they are broken. Stills keep everything (every star there has one observation
        // by construction).
        // On a still every star has exactly ONE observation by construction, and its transforms
        // array is the single solve EXPANDED across the nominal timeline - so the threshold must
        // come from the still flag, never from transform count, or every star gets filtered.
        const totalFrames = myResult.solved.transforms.length || 1;
        const minIdentifyObs = myResult.still ? 1
            : Math.min(25, Math.max(1, Math.ceil(0.15 * totalFrames)));
        // disabledStars holds the circles the user clicked off in the video view - their call,
        // no questions asked: a light they know is a planet, a plane, or a bad track.
        // Identification runs on the 2D reference chart and on the star set THAT chart produced -
        // `klass2D` when the lens fit has re-judged the classification, `klass` otherwise.
        //
        // Deliberately not the improved star set. Identify hashes quads with a planar-similarity
        // code and verifies against a gnomonic field, and it is calibrated end to end against
        // what the 2D chart yields; feeding it the ~60 additional EDGE stars the lens fit
        // recovers loses its match consensus on the reference clip. Projecting the spherical map
        // gnomonically instead was tried and did not fix it either - plausibly because the chart
        // then spans the true ~87 deg rather than the ~21 deg the similarity chain compressed it
        // to, which is a wider field than the identifier's tiers cover. Migrating Identify to the
        // sphere is its own piece of work; until then the two features stay decoupled.
        // A KNOWN fisheye lens has no usable 2D chart - a 160-degree field is not a plane -
        // so the identifier is handed a gnomonic chart of the solved SPHERE instead, limited to
        // the central field a plane can represent. See sphereIdentifyChart.
        const sphereChart = sphereIdentifyChart(myResult, minIdentifyObs);
        myResult.sphereChart = sphereChart;
        const stars = sphereChart ? sphereChart.stars : myResult.solved.classified
            .filter((c) => (c.klass2D ?? c.klass) === "star" && c.position
                && Number.isFinite(c.magnitude)
                && c.n >= minIdentifyObs
                && !myResult.disabledStars?.has(c.index))
            .map((c) => ({x: c.position[0], y: c.position[1], mag: c.magnitude, index: c.index,
                // The track's ACTUAL observation frames. Windowed identification cuts and
                // admits by these - tracks are gappy, and a [first, last] span overstates what
                // any given window really saw of them.
                obsF: myResult.solved.tracks[c.index].obs.map((o) => o.f),
                // How much this track looks like a POINT SOURCE, for choosing quad anchors.
                // Read off the detector's own records rather than recomputed, and medianed over
                // the track's detections so one bad frame cannot decide it. Without these the
                // solver ranks anchors by brightness, which on a twilight photo means the
                // treeline - lit foliage is bright because a clump is large.
                ...pointSourceStats(myResult.solved.tracks[c.index])}));

        // When the source carries optics metadata, the plate scale is KNOWN - the strongest
        // prune a blind solver can be handed - and the field of view says which index tier to
        // try first: a 24mm phone frame spans ~67 deg, which only the wide tier can represent.
        const optics = myResult.videoData?.importMetadata?.optics;
        // The metadata's vertical FOV describes the sensor's SHORT axis, and the solver's scale
        // lives in gnomonic tangent units - scalePriorFromFov handles both, so portrait photos
        // do not arrive with a 40% prior error that fails every tier.
        const scalePrior = optics?.verticalFovDeg > 0 && myResult.videoH
            ? scalePriorFromFov(optics.verticalFovDeg, myResult.videoW, myResult.videoH)
            : undefined;
        // The long axis' field, and the same tangent-vs-radian trap the solver's own guard fell
        // into: scalePrior is TANGENT UNITS per pixel, so half the frame spans tan(fov/2) and the
        // angle is the arctangent. Read linearly this crossed the 35 deg threshold at a true 34.0
        // deg - a small error, but it decides which index tier is tried first.
        const fovWdeg = scalePrior
            ? 2 * Math.atan(scalePrior * Math.max(myResult.videoW, myResult.videoH) / 2)
                * 180 / Math.PI
            : (sphereChart ? sphereChart.fovDeg : 0);
        const tierOrder = STAR_IDENTIFY_DEFAULTS.tiers.map((_, i) => i);
        if (fovWdeg > 35) tierOrder.reverse();

        // Everything below may run several solves - a windowed clip runs one per window - and
        // they all share the same scale prior and live-display options.
        const commonSolveOpts = {
            ...(scalePrior ? {scalePrior} : {}),
            ...(sphereChart ? {verifyPixelFraction: SPHERE_CHART_VERIFY_FRACTION} : {}),
            ...(params.showDuringAnalysis ? {
                onYield: yieldToBrowser,
                onCandidate: (q) => {
                    // Best-last, so the strongest quad paints on top of the others.
                    liveQuads.push(q);
                    liveQuads.sort((a, b) => a.fraction - b.fraction);
                    if (liveQuads.length > MAX_LIVE_QUADS) liveQuads.shift();
                    setRenderOne();
                },
            } : {}),
        };
        const ensureIndex = async (tier) => {
            if (!quadIndexes[tier]) {
                params.status = `building star geometry index (tier ${tier + 1})`;
                await yieldToBrowser();
                quadIndexes[tier] = buildQuadIndex(catalog, STAR_IDENTIFY_DEFAULTS.tiers[tier]);
            }
            return quadIndexes[tier];
        };
        // Join the names on, keyed by the classified-track index the overlay draws from.
        const joinNames = (entries) => {
            const identified = new Map();
            for (const [index, m] of entries) {
                const nm = names.get(m.hip);
                const label = nm?.name
                    || (nm?.greek ? `${nm.greek} ${nm.constellation}` : `HIP ${m.hip}`);
                identified.set(index, {
                    label, hip: m.hip, mag: m.mag, raDeg: m.raDeg, decDeg: m.decDeg,
                    dPx: m.dPx,
                    // A PROPER name (Altair, Deneb) - drawn more prominently than the Bayer
                    // and HIP-number fallbacks.
                    named: !!nm?.name,
                });
            }
            return identified;
        };
        const refreshSyncedCamera = () => {
            // A scoring run's solve covers ONE frame and is thrown away moments later. Re-baking a
            // camera the user synced from a whole clip onto it would swing their view for every
            // candidate a search tries, and leave it pointing at the last one.
            if (scoring) return;
            // A previously-synced camera keeps driving from its BAKE, so a re-identification
            // (say, after toggling stars off) must RE-BAKE it whole. Refreshing only the live
            // FOV array - the old behaviour - left the heading and the serialized vfovDeg/
            // vfovTrack on the previous solve: zoom and heading came from two different
            // solves, and a save then froze the stale pair for every reload. When the new
            // solve cannot bake (a windowed identify with partial coverage), the old bake is
            // left intact rather than half-updated; pressing Sync explains why.
            const ctrl = NodeMan.get("starTrackCameraController", false);
            if (!ctrl?.poseTrack) return;
            if (ctrl.bakeFrom(myResult)) {
                attachStarTrackCamera(ctrl, false);
                setRenderOne();
            }
        };

        // A clip whose chart robustly extends well beyond the video frame is a PAN, and a
        // pan's chart carries time-accumulated stitching drift that no single plate model can
        // fit (the windowed-identification block in StarIdentify.js holds the measurements).
        // Such clips are identified per time window and the labels merged; everything else
        // takes the single whole-chart solve below, exactly as before.
        // The bounds the blind solve verifies within. On the 2D chart: the UNION of the video
        // rectangle and the map's bounding box (see below). On a sphere chart there is no video
        // rectangle - the chart is its own frame - so the stars' own extent is the field.
        const starBounds = (set) => {
            let bx0 = sphereChart ? Infinity : 0, by0 = sphereChart ? Infinity : 0;
            let bx1 = sphereChart ? -Infinity : (myResult.videoW || 0);
            let by1 = sphereChart ? -Infinity : (myResult.videoH || 0);
            for (const s of set) {
                if (s.x < bx0) bx0 = s.x;
                if (s.x > bx1) bx1 = s.x;
                if (s.y < by0) by0 = s.y;
                if (s.y > by1) by1 = s.y;
            }
            return {bx0, by0, bx1, by1};
        };
        const transforms = myResult.solved.transforms;
        if (!myResult.still && !sphereChart && myResult.videoW && transforms?.length > 1
            && chartSpansBeyondFrame(stars, myResult.videoW, myResult.videoH)) {
            const indexes = [];
            for (const tier of tierOrder) {
                indexes.push(await ensureIndex(tier));
                if (!fresh()) return;
            }
            const win = await solveFieldWindowed(stars, catalog, indexes, {
                videoW: myResult.videoW,
                videoH: myResult.videoH,
                transforms,
                totalFrames: transforms.length,
                solveOpts: commonSolveOpts,
                onWindowStatus: (k, n) => {
                    params.status = `matching window ${k}/${n}`;
                },
                shouldStop: () => !fresh(),
            });
            if (!win || !fresh()) return;
            if (win.ok) {
                myResult.identify = {
                    solved: win.primary.solved,
                    windowed: true,
                    // The surviving windows, for the per-frame pose lookup: each covers
                    // [w0, w1) in analysed-frame numbers and carries its own calibration.
                    windows: win.surviving.map((w) => ({w0: w.w0, w1: w.w1, solved: w.solved})),
                    partial: win.partial,
                    covered: win.covered,
                    report: win.windows,
                    identified: joinNames(win.labels),
                };
                refreshSyncedCamera();
                // The status zoom figure comes from the primary window; when the windows
                // disagree on plate scale beyond noise the baked FOV varies per frame, and
                // the status says so.
                const scales = win.surviving.map((w) => w.solved.pxPerDeg);
                const spread = (Math.max(...scales) - Math.min(...scales))
                    / Math.min(...scales);
                const uncovered = win.partial
                    ? " - frames " + win.covered.map(([a, b]) =>
                        `${myResult.frame0 + a}-${myResult.frame0 + b - 1}`).join(", ")
                        + " only"
                    : "";
                params.status = `identified ${myResult.identify.identified.size}`
                    + `/${stars.length} stars in ${win.surviving.length}`
                    + `/${win.windows.length} windows${uncovered}`
                    + (spread > 0.02 ? " - zoom varies across the pan" : "");
                setRenderOne();
                return;
            }
            params.status = "no window solved - trying the whole chart";
            await yieldToBrowser();
        }

        let solved = null;
        for (const tier of tierOrder) {
            await ensureIndex(tier);
            if (!fresh()) return;
            params.status = `matching against ${quadIndexes[tier].n} catalog quads (tier ${tier + 1})`;
            await yieldToBrowser();
            // The reference frame is frame-0 pixels, but a panning clip carries the star map
            // far beyond the frame-0 rectangle - stars that entered the view later live at
            // reference positions outside it, and confining the solver's bounds to the video
            // rect makes those stars unmatchable while still counting them in the consensus
            // denominator (a wide-range solve fails outright on exactly the map that has the
            // MOST evidence). The field is therefore the UNION of the video rectangle and the
            // map's own bounding box: never smaller than the frame - so a sparse or lopsided
            // sky cannot misstate a narrow field - and exactly as large as the pan made it.
            const {bx0, by0, bx1, by1} = starBounds(stars);
            const boundsPad = 12;
            solved = await solveField(stars, catalog, [quadIndexes[tier]], {
                ...(myResult.videoW ? {
                    center: [(bx0 + bx1) / 2, (by0 + by1) / 2],
                    width: Math.max(bx1 - bx0, by1 - by0),
                    bounds: [bx0 - boundsPad, by0 - boundsPad, bx1 + boundsPad, by1 + boundsPad],
                } : {}),
                ...commonSolveOpts,
            });
            if (!fresh()) return;
            if (solved.ok) break;
        }
        if (!solved || !solved.ok) {
            // FAILURE LADDER. A knife-edge input - one or two marginal tracks the solver
            // cannot digest - can starve quad generation while the field remains perfectly
            // solvable from its reliable core (measured: inputs that failed outright solved
            // from their 11-12 most persistent tracks). So retry on progressively smaller
            // views ranked by persistence. A capped view shrinks every consensus denominator
            // though, which makes acceptance structurally EASIER - so a view's solve may not
            // ship until certifySolve has re-verified its pose against the full input with
            // the full input's own arithmetic. Labels then come from that certification, so
            // a rescued solve still names every star the pose explains, not just the view.
            const boundsOpts = (set) => {
                const {bx0, by0, bx1, by1} = starBounds(set);
                return {
                    center: [(bx0 + bx1) / 2, (by0 + by1) / 2],
                    width: Math.max(bx1 - bx0, by1 - by0),
                    bounds: [bx0 - 12, by0 - 12, bx1 + 12, by1 + 12],
                };
            };
            for (const cap of [12, 11]) {
                if (stars.length <= cap) continue;
                const view = [...stars]
                    .sort((a, b) => b.n - a.n || a.mag - b.mag || a.index - b.index)
                    .slice(0, cap);
                params.status = `identify failed - retrying with the ${cap} most persistent stars`;
                await yieldToBrowser();
                let attempt = null;
                for (const tier of tierOrder) {
                    await ensureIndex(tier);
                    if (!fresh()) return;
                    attempt = await solveField(view, catalog, [quadIndexes[tier]], {
                        ...(myResult.videoW ? boundsOpts(view) : {}),
                        ...commonSolveOpts,
                    });
                    if (!fresh()) return;
                    if (attempt.ok) break;
                }
                if (!attempt?.ok) continue;
                const cert = certifySolve(attempt, stars, catalog);
                if (!cert.ok) continue;
                solved = {...attempt, matches: cert.matches, nImage: cert.nImage,
                    matchedFraction: cert.matchedFraction, rmsPx: cert.rmsPx,
                    tolPx: cert.tolPx, certifiedFromCap: cap};
                break;
            }
        }
        if (!solved || !solved.ok) {
            params.status = `identify failed: ${solved ? solved.reason : "no result"}`;
            return;
        }

        myResult.identify = {solved,
            identified: joinNames(solved.matches.map((m) => [stars[m.image].index, m])),
            // The chart the plate solution is expressed in, when it is the sphere's: the
            // camera pose then goes pixel -> direction -> chart -> sky (sphereChartPose).
            chart: sphereChart ? sphereChart.chart : null};
        // Named stars are pixel <-> catalog correspondences, and on a known-lens run they are
        // used to CALIBRATE that lens: the hand-matched render is right to a few percent, the
        // stars say exactly. The user's projection type is kept; focal, centre and the
        // orientation are fitted, then widened to every star the frame holds.
        myResult.lensFit = sphereChart ? fitFisheyeLensFromCatalog(myResult, catalog, solved, stars) : null;
        refreshSyncedCamera();
        const raH = solved.centerRaDeg / 15;
        params.status = `identified ${solved.matches.length}/${stars.length} stars - `
            + `field ${solved.fovDeg.toFixed(1)} deg at RA ${raH.toFixed(2)}h `
            + `Dec ${solved.centerDecDeg.toFixed(1)} deg, rms ${solved.rmsPx.toFixed(1)} px`
            + (solved.certifiedFromCap
                ? ` (rescued from a ${solved.certifiedFromCap}-star retry, certified)` : "");
        setRenderOne();
    } catch (e) {
        // Only while this run still owns the state - a failure surfacing after a sitch change
        // must not write over the new sitch's status.
        if (fresh()) params.status = `identify failed: ${e?.message ?? e}`;
    } finally {
        // Deliberately NOT cleared: the quads stay on screen as the visible evidence for the
        // identification. Nothing misleading survives a failure either, since onCandidate only
        // ever fires for a hypothesis that passed verification - a failed solve verified none,
        // so there is nothing in the list to leave behind.
        setRenderOne();
    }
}

/**
 * Detect, solve, and classify over the In/Out (A-B) window.
 *
 * The window comes from abFrameRange, the same authority every other Sitrec analysis uses, so
 * moving the In/Out markers changes what this analyses in the way the user expects.
 *
 * opts.singleFrame analyses ONLY the frame on screen, on the same terms a still image is analysed:
 * one exposure of the sky, every detection presumed a star, nothing to classify as moving. It
 * exists for the tweak optimizer, which needs an answer per candidate in seconds - a full pass over
 * a 900-frame clip per candidate would be an afternoon. opts.quiet suppresses the blocking progress
 * overlay, which the same caller needs: it runs this repeatedly, and an input blocker flashing up
 * ten times would take the user's own Abort button away from them.
 */
export async function runStarTracker(opts = {}) {
    const singleFrame = !!opts.singleFrame;
    const quiet = !!opts.quiet;
    const view = videoView();
    if (!view || !view.videoData || running) return null;
    running = true;
    aborted = false;
    enough = false;

    // Everything this run is tied to, captured once at the start.
    //
    // The settings are SNAPSHOTTED rather than read per frame: the controls stay live during the
    // pass, so reading them each iteration would let a mid-run edit produce a result where the
    // first half of the clip was detected at one threshold and the second half at another - a
    // silently inconsistent dataset that looks like a normal one. The In point and the view's
    // lock-to-In flag are captured for the same reason: both change where a global frame number
    // reads from.
    //
    // The generation and videoData identity are captured for the reason a sitch load guards on
    // Globals.loadGeneration: this loop awaits the decoder hundreds of times, and a sitch reload
    // part-way through would otherwise finish against the OLD video and then restore par.frame
    // and attach its results over the new one.
    const generation = Globals.loadGeneration;
    const videoData = view.videoData;
    // The snapshot below trusts `calibration`; a same-sitch video swap must not let it carry
    // another video's plate scale into this analysis.
    dropCalibrationForOtherVideo(videoData);
    const ctx = {
        threshSigma: params.threshSigma,
        minArea: params.minArea,
        minObservations: params.minObservations,
        driftSignificance: params.driftSignificance,
        driftMinSigmas: params.driftMinSigmas,
        // The measured pixel-scale parameters, snapshotted with everything else. Split into the
        // options each stage understands: blob-scale apertures for the detector, and the
        // blob-scale association gate and artifact bound for the solver.
        calDetect: calibration ? {
            apertureRadius: calibration.apertureRadius,
            annulusInner: calibration.annulusInner,
            annulusOuter: calibration.annulusOuter,
        } : {},
        calSolve: {
            // Dropout tolerance is a DURATION: the same 0.3 s dropout spans twice the frames at
            // twice the frame rate, so a gap allowance fixed in frames fragments identical
            // footage differently across frame rates. The floor is ZERO, not one - at very low
            // frame rates even a single missing frame exceeds the tolerated duration, and a
            // floor of one would quietly tolerate a full second's gap at 1 fps. A zero gap
            // still links consecutive frames; it only refuses to coast across missing ones.
            trackMaxGap: Math.max(0,
                Math.round(STAR_SOLVE_DEFAULTS.trackMaxGap * (Sit.fps || 30) / 30)),
            ...(calibration ? {
                trackRadius: calibration.trackRadius,
                cameraFixedMaxRawSpan: calibration.cameraFixedMaxRawSpan,
            } : {}),
        },
        // The cluster gates are stated at the reference footage's scale: pixel radii assume its
        // plate scale, and the px-per-frame speed gates additionally assume its 30 fps - the
        // same object filmed at 60 fps moves half as far per frame. Both are scaled to what
        // THIS clip measures, or equivalent footage at another resolution or frame rate would
        // be classified differently. The plate-scale ratio comes from the measured PSF radius
        // directly - the derived trackRadius is CLAMPED for its own purposes, and a clamped
        // proxy would cap the scale at the clamp ratio.
        calCluster: (() => {
            // calibrateDetection sets trackRadius = 3 * rPsf, so the defaults' trackRadius of 6
            // corresponds to a reference PSF radius of 2 px.
            //
            // Bounded, because the PSF radius is only a PROXY for plate scale: zoom enlarges
            // blobs and separations and motion together, but defocus, haze or long exposure
            // enlarge only the blobs. The proxy cannot tell the two apart, so each gate is
            // bounded in the direction its own failure costs most. The SPEED gates exist to
            // reject solve drift, and over-scaling them rejects real movers - an accepted
            // 4000 px blob would scale the minimum speed ~18x - so they stay within a factor
            // of four of reference, where the proxy is more right than a fixed default. The
            // RADII fail the other way round: UNDER-scaling them rejects genuinely wide
            // formations on genuinely long lenses, while over-scaling merely widens a search
            // area that the velocity-agreement, light-count and drift gates still police - so
            // they follow the measurement twice as far.
            const raw = calibration ? calibration.rPsf / 2.0 : 1;
            const pxScaleRadii = Math.min(8, Math.max(0.5, raw));
            const pxScaleSpeed = Math.min(4, Math.max(0.5, raw));
            const fpsScale = 30 / (Sit.fps || 30);
            return {
                clusterRadius: STAR_CLUSTER_DEFAULTS.clusterRadius * pxScaleRadii,
                clusterAttachRadius: STAR_CLUSTER_DEFAULTS.clusterAttachRadius * pxScaleRadii,
                clusterVelocityFloor: STAR_CLUSTER_DEFAULTS.clusterVelocityFloor * pxScaleSpeed * fpsScale,
                clusterMinSpeed: STAR_CLUSTER_DEFAULTS.clusterMinSpeed * pxScaleSpeed * fpsScale,
            };
        })(),
        lockToInFrame: !!view.lockToInFrame,
        aFrame: Sit.aFrame ?? 0,
        applyAdjustments: !!params.applyAdjustments,
        stale: () => aborted
            || Globals.loadGeneration !== generation
            || videoView() !== view
            || view.videoData !== videoData,
    };

    const ab = abFrameRange(Sit.frames, 1);
    // A single-frame run analyses the frame on screen, clamped into the A-B window so it cannot
    // measure a frame the rest of the run would refuse to look at.
    const frame0 = singleFrame
        ? Math.max(ab.frame0, Math.min(ab.frame1, Math.floor(par.frame)))
        : ab.frame0;
    const frame1 = singleFrame ? frame0 : ab.frame1;
    const total = frame1 - frame0 + 1;
    const savedFrame = par.frame;

    // A still image on a video timeline (CVideoImageData) has ONE real frame however many the
    // timeline claims - detecting it hundreds of times over would be minutes of work for one
    // answer, and with no motion there is nothing to solve or classify: every detected point
    // is presumed a star, which is all a single exposure of the sky can honestly claim.
    // Established before the progress UI, which offers "Enough" only for a real multi-frame pass.
    //
    // A deliberate single-frame run is the same situation arrived at by choice rather than by the
    // source's nature - one exposure, nothing to compare it against - so it takes the same path.
    const still = videoData instanceof CVideoImageData || singleFrame;

    const wasPaused = par.paused;
    // The previous identification's quads describe the previous solve. A new analysis replaces
    // the map they were drawn against, so they go now rather than lingering over fresh results.
    liveQuads = [];
    // Set once the analysis has produced a result, so the finally can tell "finished" (park on the
    // first analysed frame, which is what the overlay now describes) from "aborted or failed"
    // (put the user back where they were, since nothing was produced to look at).
    let completed = false;

    try {
        // The detect pass steps par.frame itself, one analysed frame at a time. If normal playback
        // is running it advances the same counter, so the two interleave and frames get measured
        // out of order or skipped. Pause it, and hold the lock so nothing can resume mid-pass.
        //
        // Taken INSIDE the try, together with everything else that must be undone: acquiring the
        // lock before it would leave playback locked forever if the setup below threw.
        par.paused = true;
        par.pausedLock = true;

        // The later updateProgress calls need no guard: with no overlay shown they write to
        // hidden elements and do nothing. Only initProgress blocks input, and only hideProgress
        // un-blocks it, so those are the two that a quiet run must not make.
        if (!quiet) {
            initProgress({
                title: "Star Tracker",
                filename: `Analyzing frames ${frame0}-${frame1}`,
                showAbort: true,
                onAbort: () => { aborted = true; },
                // Only worth offering when there is more than one frame to stop short of.
                showEnough: !still && total > 1,
                onEnough: () => { enough = true; },
                enoughLabel: "Enough (solve what we have)",
            });
        }

        const perFrame = [];
        let videoW = 0, videoH = 0;
        const rejectCounts = {};
        const rejectSamples = [];

        // The shared video mask, when the user wants it respected. Resolved ONCE for the run: it
        // is a user artefact that should not change mid-pass, and refreshing its pixels per frame
        // would cost a full getImageData on every one.
        //
        // Note what this does and does not do. Detections inside masked regions are DISCARDED
        // after detection, which keeps foliage out of the tracks, the solve and identification.
        // It does not stop the detector looking there, so masked pixels still contribute to the
        // local background estimate near the mask boundary. Detecting less would mean pushing the
        // mask down into detectSources, which is a bigger change for a smaller gain.
        const maskNode = params.useMask ? NodeMan.get("videoMask", false) : null;
        if (maskNode?.maskCanvas) maskNode.updateMaskImageData();
        const maskUsable = !!(maskNode?.maskCanvas && maskNode.maskImageData);

        const lastFrame = still ? frame0 : frame1;
        // The frame the run actually reached. Reported as the result's frame1 so the overlay and
        // the pose lookup, which both map a global frame to an index via frame0, describe the
        // clip that was measured rather than the one that was requested.
        let analysedLast = lastFrame;

        // The "too big to be a star" bound scales with SENSOR AREA: the default was
        // measured on 720p-class footage, and on a 12-megapixel astrophoto the saturated
        // disk of a first-magnitude star legitimately covers tens of thousands of pixels -
        // a fixed bound silently deletes exactly the brightest stars in the image.
        const dynMaxArea = (W, H) => Math.round(STAR_DETECT_DEFAULTS.maxArea
            * Math.max(1, (W * H) / (1276 * 720)));
        const detectOpts = (maxArea) => ({
            threshSigma: ctx.threshSigma,
            minArea: ctx.minArea,
            maxArea,
            ...ctx.calDetect,
        });

        // Everything that happens to a frame AFTER detection, shared by the parallel pass and
        // the synchronous one so the two cannot disagree. Runs strictly in frame order however
        // detections complete: perFrame is indexed by frame, and the first-200 cap on
        // rejectSamples makes even the tally order-sensitive. `det` is null for a frame that
        // yielded no pixels, else {sources, W, H, maxArea} carrying the settings detection ran
        // with - rejection must judge with the SAME maxArea the detector used, or the two
        // disagree about "huge" exactly when frames differ in size.
        const finalizeFrame = (f, det) => {
            // The playhead follows the FINISHED frames, not the decode. In the synchronous pass
            // the two are the same and this re-asserts what frameImage already set; in the
            // pipelined pass the decode runs ahead, and the video on screen must stay on the
            // frame the preview circles were measured on - drawing frame N's detections over
            // frame N+8 of a panning sky visibly misplaces every circle. The decode frontier
            // stays within the pipeline depth of this, comfortably inside the 30-frame cache
            // window the render loop maintains around par.frame.
            par.frame = f;
            if (!det) { perFrame.push([]); return; }
            // The WHOLE detector record is kept, not a trimmed copy. Stage 3's photometry reads
            // apertureFlux/apertureComplete/apertureContaminated off it, and stripping the object
            // down to positions silently demotes every magnitude to the biased isophotal fallback.
            // Rejection runs with the SAME settings detection did, or the two disagree about
            // minArea and quietly re-reject blobs the user's setting admitted. What gets
            // rejected, and why, is tallied onto the result - "why is that star not circled"
            // should be answerable by looking.
            const kept = [];
            for (const s of det.sources) {
                const why = rejectReason(s, {minArea: ctx.minArea, maxArea: det.maxArea});
                if (why) {
                    rejectCounts[why] = (rejectCounts[why] || 0) + 1;
                    if (rejectSamples.length < 200) {
                        rejectSamples.push({
                            why, f, x: Math.round(s.x), y: Math.round(s.y),
                            area: s.area, elongation: +s.elongation.toFixed(2),
                            peakSNR: +s.peakSNR.toFixed(1),
                        });
                    }
                } else {
                    kept.push(s);
                }
            }

            // Drop what the mask excludes, tallied like any other rejection so the accounting
            // stays honest - a star missing because it is under the mask should be answerable.
            //
            // Detections are in the ANALYSED decode space, which is not necessarily the space the
            // mask was painted in: a 4K clip may be decoded at a capped resolution while the mask
            // canvas is video-sized. Scale into the mask canvas rather than assuming one grid.
            let accepted = kept;
            if (maskUsable && det.W && det.H) {
                const msx = maskNode.maskCanvas.width / det.W;
                const msy = maskNode.maskCanvas.height / det.H;
                accepted = [];
                for (const s of kept) {
                    if (maskNode.isPointMasked(s.x * msx, s.y * msy)) {
                        rejectCounts.masked = (rejectCounts.masked || 0) + 1;
                    } else {
                        accepted.push(s);
                    }
                }
            }
            perFrame.push(accepted);

            // Live preview. `accepted` is handed over by reference rather than copied: the array
            // is freshly built each frame and only read by the draw, so a copy per frame would
            // be pure waste on a pass that already has thousands of frames to get through.
            if (params.showDuringAnalysis && ensureOverlay()) {
                // What SURVIVED, not what was detected: showing masked detections would make the
                // mask look like it was not working while it was.
                liveDetections = {frame: f, sources: accepted, W: det.W, H: det.H};
                setRenderOne();
            }
        };

        const tDetect = Date.now();
        let workerCount = 0;

        if (still || total <= 1 || !detectWorkersAvailable()) {
            // The synchronous pass: stills and single frames (one real detection, so a pool
            // would cost more than it saves) and environments with no Worker. Frame by frame,
            // exactly the shape the analysis always had.
            for (let f = frame0; f <= lastFrame; f++) {
                if (ctx.stale()) {
                    params.status = aborted ? "aborted" : "cancelled (video changed)";
                    return null;
                }
                // Tested at the TOP of the loop, and never on the first frame: it must also
                // short-circuit the `continue` taken when a frame yields no pixels, and a solve
                // needs at least one measured frame to have anything to say.
                if (enough && f > frame0) {
                    analysedLast = f - 1;
                    console.log(`Star Tracker: stopped early at frame ${analysedLast} of ${lastFrame}`);
                    break;
                }
                const done = f - frame0 + 1;
                params.status = still ? "detecting (still image)" : `detecting ${done}/${total}`;
                updateProgress({
                    percent: still ? 40 : (done / total) * 90,
                    status: still ? "Detecting sources in the still image"
                        : `Detecting sources: ${done}/${total}`,
                });

                await yieldToBrowser();
                const px = await framePixels(view, f, ctx);
                if (!px) { perFrame.push([]); continue; }
                if (!videoW) { videoW = px.W; videoH = px.H; }

                const maxArea = dynMaxArea(px.W, px.H);
                const {sources} = detectSources(px.data, px.W, px.H, detectOpts(maxArea));
                finalizeFrame(f, {sources, W: px.W, H: px.H, maxArea});
            }
        } else {
            // The pipelined pass. Decode stays HERE - the decoder, the canvas readback and
            // par.frame are all main-thread - and each decoded frame is handed to the worker
            // pool while the next one decodes, so decode and detection overlap and detection
            // itself runs across the cores. Nothing about a frame's ANSWER changes: the workers
            // run the same detectSources on the same bytes, and finalizeFrame runs in strict
            // frame order however the completions interleave.
            //
            // The decode runs AHEAD of the finished detections by at most the pool size plus a
            // small buffer - enough that no worker ever waits for pixels. The bound matters
            // twice over: each in-flight frame is a multi-megabyte RGBA buffer, and the
            // decoder's getImage purges its GOP cache outside a 30-frame window of the frame it
            // is asked for, so a decode frontier further ahead than that would fight the render
            // loop over the cache. The pool caps at 8, so the frontier stays well inside both.
            const results = new Map();   // frame index -> det record, null, or {retry: frame}
            let nextIdx = 0;             // the next frame index finalizeFrame is owed
            let dispatched = 0;          // frame indices handed to the pipeline so far
            let inFlight = 0;
            let maxInFlight = 1;         // grows once the pool exists and its size is known
            let workersBroken = false;
            // The completion gate. A single main flow waits on it, so one waiter at most.
            let wake = null;
            const wakeUp = () => { const w = wake; wake = null; if (w) w(); };
            const waitWake = () => new Promise((r) => { wake = r; });

            const announce = () => {
                params.status = `detecting ${nextIdx}/${total}`;
                updateProgress({
                    percent: (nextIdx / total) * 90,
                    status: `Detecting sources: ${nextIdx}/${total}`,
                });
            };

            // Finalize every frame whose result has arrived, in order. A frame whose worker
            // failed is re-decoded and detected here on the main thread: its pixel buffer went
            // to the worker as a TRANSFER, so re-decoding is the recovery - same detector, same
            // answer, just slower.
            const settle = async () => {
                while (nextIdx < dispatched && results.has(nextIdx)) {
                    let det = results.get(nextIdx);
                    results.delete(nextIdx);
                    if (det && det.retry !== undefined) {
                        const px = await framePixels(view, det.retry, ctx);
                        if (px) {
                            const maxArea = dynMaxArea(px.W, px.H);
                            det = {sources: detectSources(px.data, px.W, px.H,
                                detectOpts(maxArea)).sources, W: px.W, H: px.H, maxArea};
                        } else {
                            det = null;
                        }
                    }
                    finalizeFrame(frame0 + nextIdx, det);
                    nextIdx++;
                    announce();
                }
            };

            // One real yield before the dispatch loop, so the progress dialog paints before the
            // first burst of decodes. After that the loop yields naturally: every wait on the
            // gate below is a macrotask boundary, which is when worker replies arrive and the
            // browser repaints - a per-frame yield here would put the ~4 ms setTimeout clamp
            // back into a loop this change exists to unblock.
            await yieldToBrowser();

            // The playhead moves to the analysed window BEFORE the first decode, then advances
            // per FINISHED frame in finalizeFrame while the decodes below run ahead of it
            // without touching it. It cannot be left where the user parked it: the render loop
            // purges the decoder's cache outside a 30-frame window of par.frame, so a playhead
            // far from frame0 would evict the very groups the first dispatches are decoding.
            par.frame = frame0;

            for (let f = frame0; f <= lastFrame; f++) {
                if (ctx.stale()) {
                    params.status = aborted ? "aborted" : "cancelled (video changed)";
                    // In-flight frames are pure waste now - stop burning cores on them.
                    terminateDetectWorkers();
                    return null;
                }
                // Tested at the TOP of the loop, and never on the first frame, exactly as the
                // synchronous pass tests it. Frames already handed to the pipeline still finish
                // in the drain below, so "Enough" keeps everything measured up to the click.
                if (enough && f > frame0) {
                    analysedLast = f - 1;
                    console.log(`Star Tracker: stopped early at frame ${analysedLast} of ${lastFrame}`);
                    break;
                }
                await settle();
                while (inFlight >= maxInFlight) { await waitWake(); await settle(); }

                const px = await framePixels(view, f, ctx, false);
                const idx = f - frame0;
                dispatched = idx + 1;
                if (!px) { results.set(idx, null); continue; }
                if (!videoW) { videoW = px.W; videoH = px.H; }
                const maxArea = dynMaxArea(px.W, px.H);

                // The pool is sized from the frames it will actually chew on - the memory bound
                // in workerCountFor needs real dimensions - so it cannot be built until the
                // first one is decoded.
                if (!workersBroken && !workerCount) {
                    try {
                        workerCount = ensureDetectPool(px.W, px.H);
                        maxInFlight = workerCount + 2;
                    } catch (e) {
                        console.warn("[StarTrack] detect worker pool failed to start; "
                            + "detecting on the main thread", e);
                        terminateDetectWorkers();
                        workersBroken = true;
                    }
                }
                if (workersBroken) {
                    // The synchronous pass's shape, one frame at a time, yield included.
                    await yieldToBrowser();
                    const {sources} = detectSources(px.data, px.W, px.H, detectOpts(maxArea));
                    results.set(idx, {sources, W: px.W, H: px.H, maxArea});
                    continue;
                }

                inFlight++;
                detectInPool(px.data, px.W, px.H, detectOpts(maxArea))
                    .then((sources) => { results.set(idx, {sources, W: px.W, H: px.H, maxArea}); })
                    .catch((e) => {
                        // Rejected because the run went stale and tore the pool down: the loop
                        // has already returned, nothing will read this frame, and warning would
                        // blame a worker for an abort.
                        if (ctx.stale()) { results.set(idx, {retry: f}); return; }
                        if (!workersBroken) {
                            workersBroken = true;
                            console.warn("[StarTrack] detect worker failed; "
                                + "detecting remaining frames on the main thread", e);
                            // A broken pool can leave jobs parked on workers that will never
                            // answer. Tearing it down fails them all NOW, into this retry path,
                            // instead of hanging the pass on a reply that never comes.
                            terminateDetectWorkers();
                        }
                        results.set(idx, {retry: f});
                    })
                    .finally(() => { inFlight--; wakeUp(); });
            }

            // Drain: every dispatched frame is finalized before the solve reads perFrame.
            while (nextIdx < dispatched) {
                if (ctx.stale()) {
                    params.status = aborted ? "aborted" : "cancelled (video changed)";
                    terminateDetectWorkers();
                    return null;
                }
                await settle();
                if (nextIdx < dispatched && !results.has(nextIdx)) await waitWake();
            }
        }

        console.log(`[StarTrack] detect pass ${Date.now() - tDetect}ms `
            + `(${perFrame.length} frames, ${workerCount ? `${workerCount} workers` : "main thread"})`);

        // Scanning is over, so the per-frame preview stops owning the overlay - the solve stages
        // below have their own displays, and the draw order prefers this one. Cleared here rather
        // than in the finally, which only runs once the whole analysis has finished.
        //
        // Wiping the canvas as well as the state is the point: dropping the state alone stops it
        // being REDRAWN but leaves the last frame's circles painted, so they sit there through
        // stages they have nothing to do with, looking like live output.
        liveDetections = null;
        clearOverlayCanvas();

        if (ctx.stale()) {
            params.status = aborted ? "aborted" : "cancelled (video changed)";
            return null;
        }
        params.status = "solving";
        // The two solves below are synchronous and cannot be interrupted, so yield first to let
        // the message paint - otherwise the bar sits at 90% with no explanation while they run.
        updateProgress({percent: 93, status: "Solving camera motion"});
        await yieldToBrowser();
        const chain = solveFrameChain(perFrame);

        updateProgress({percent: 96, status: "Building star map"});
        await yieldToBrowser();
        const solved = solveStarField(perFrame, chain.cumulative, {
            // On a still, single observations carry the whole claim, and two detections in
            // one frame are two stars by definition - so merging is off.
            minObservations: still ? 1 : ctx.minObservations,
            ...(still ? {starMergeRadius: 0} : {}),
            driftSignificance: ctx.driftSignificance,
            driftMinSigmas: ctx.driftMinSigmas,
            ...ctx.calSolve,
        });
        if (ctx.stale()) {
            params.status = aborted ? "aborted" : "cancelled (video changed)";
            return null;
        }

        // A still's solve covers one frame; the overlay indexes transforms by the CURRENT
        // slider position, and the image is the same at every one of them - so the single
        // transform is held across the whole nominal range.
        if (still) {
            const T0 = solved.transforms[0] ?? {A: [1, 0], B: [0, 0]};
            solved.transforms = Array.from({length: total}, () => T0);
        }

        // Stage 3b: fit the LENS and re-judge the classification on the sphere.
        //
        // Everything above stays exactly as it was. The 2D solve still decides which detections
        // belong to which track and still supplies the reference chart the overlay draws in -
        // it is good at both, and its ~10 px edge error is nothing next to a 6-24 px circle.
        // What it is not good enough for is deciding whether a star MOVED, because that same
        // 10 px is the whole measurement. So the geometry is redone here and only the verdict
        // is overwritten.
        //
        // Measured on the reference clip (a ~89 deg IR monocular, sky rotating about a pole just
        // past the top-right corner): the 2D model explains 84 of 129 star correspondences with
        // an 11.7 px worst case and reports ~70 real stars as moving; one rotation through the
        // fitted lens explains all of them under 2.5 px.
        let lensInfo = null;
        // A KNOWN lens beats a fitted one. When the look view is rendering through the Fisheye
        // mode, the user has already matched that lens to this footage by eye, and it is taken
        // as the camera's optics outright: no calibration scan, no gate - which matters,
        // because a mounted allsky camera never turns, and calibrateLens rightly refuses a
        // clip that does not exercise the lens.
        const size = [videoW, videoH];
        const knownLens = still ? null : fisheyeStarLens(size);
        if (!still && (knownLens || params.fitLens) && solved.tracks.length) {
            try {
                // Awaited, and handed a yield: the scans inside take tens of seconds on a
                // well-populated clip and this is the UI thread. Without it the page stops
                // answering for the duration - long enough that even tooling times out.
                let cal;
                if (knownLens) {
                    cal = {accepted: true, lens: knownLens, diagnostics: {source: "fisheye"}};
                    console.log(`[StarTrack] lens from the Fisheye render: ${knownLens.type}, `
                        + `f ${knownLens.focalPx.toFixed(1)} px, principal `
                        + `(${knownLens.principal[0].toFixed(1)}, ${knownLens.principal[1].toFixed(1)})`);
                } else {
                    const tLens = Date.now();
                    updateProgress({percent: 96, status: "Fitting camera lens"});
                    await yieldToBrowser();
                    cal = await calibrateLens(solved.tracks, solved.transforms.length,
                        [videoW, videoH], {
                            onYield: yieldToBrowser,
                            ...(params.showDuringAnalysis ? {
                                onProgress: (p) => { liveStage = {kind: "lens", ...p}; setRenderOne(); },
                            } : {}),
                        });
                    console.log(`[StarTrack] calibrateLens ${Date.now() - tLens}ms`);
                }
                if (cal.accepted) {
                    const lens = cal.lens;
                    const states = statesFromChain2D(solved.transforms, lens, size);
                    attachRays(solved.tracks, states, lens, size);

                    // CAMERA-FIXED ARTIFACTS ARE THE 2D PASS'S TO DECIDE, AND ITS ANSWER STANDS.
                    // classifyTracksSpherical has no artifact test, and a hot pixel holds its
                    // PIXEL position while the sky rotates - so on the sphere it sweeps, and
                    // re-judging it here would turn dust and a reticle into confident movers.
                    // They are also kept out of the fit: they are a large, perfectly coherent
                    // contaminant, which is the kind robust trimming handles worst.
                    const artifacts = new Set();
                    for (const c of solved.classified) {
                        if (c.klass === "cameraFixed") artifacts.add(c.index);
                    }

                    // The sky-rotation solve, in one of two forms. Free: an orientation per
                    // frame, off the UI thread and across a worker pool (on a dense field this
                    // stage used to be ~121 s of a ~150 s run, synchronous, with the page
                    // unresponsive throughout - Chrome offered to kill it repeatedly; the pool
                    // returns the same numbers, not merely close ones, see
                    // StarSphereSolvePool.js). Fixed camera: one axis and one rate for the
                    // whole clip - three unknowns, cheap enough to stay on this thread with a
                    // yield per iteration.
                    const fixedCam = params.fixedCamera;
                    const solveSky = (states0, exclude, note, pct0, pctSpan) => {
                        const common = {
                            exclude,
                            shouldAbort: () => ctx.stale(),
                            onProgress: (p) => {
                                updateProgress({
                                    percent: pct0 + pctSpan * (p.iteration - 1) / p.iterations,
                                    status: `${note.status}: iteration ${p.iteration}`,
                                });
                                noteSphereProgress(note.stage, p);
                            },
                        };
                        // Three unknowns make an iteration cheap, and the alternation with
                        // the map settles more slowly than the per-frame fit's - so it is
                        // given more of them rather than reported unconverged at 0.33 px.
                        return fixedCam
                            ? refineFixedAxisSpherical(solved.tracks, states0, lens, size,
                                {...common, onYield: yieldToBrowser, refineIterations: 40})
                            : refineGlobalSphericalAsync(solved.tracks, states0, lens, size, common);
                    };
                    const tSph = Date.now();
                    updateProgress({percent: 96.5, status: "Solving sky rotation"});
                    await yieldToBrowser();
                    let refined = await solveSky(states, artifacts,
                        {status: "Solving sky rotation: pass 1", stage: "Solving sky rotation (pass 1)"},
                        96.5, 1.5);
                    if (!refined) {
                        params.status = aborted ? "aborted" : "cancelled (video changed)";
                        return null;
                    }
                    console.log(`[StarTrack] ${fixedCam ? "refineFixedAxisSpherical" : "refineGlobalSpherical"}#1 `
                        + `${Date.now() - tSph}ms (${solved.tracks.length} tracks, `
                        + `${refined.iterations} iterations, converged=${refined.converged})`);
                    const classifyOpts = {
                        minObservations: ctx.minObservations,
                        driftSignificance: ctx.driftSignificance,
                        driftMinSigmas: ctx.driftMinSigmas,
                    };
                    let sph = classifyTracksSpherical(solved.tracks, refined.states, lens, size,
                        {...classifyOpts, exclude: artifacts});

                    // STAR-ONLY RE-SOLVE, as solveStarField does for the same reason: the first
                    // pass necessarily includes the movers, and those pull on the very
                    // orientations used to judge them. Re-solve on what looks like sky, then
                    // re-classify everything against that.
                    const notSky = new Set(artifacts);
                    for (const s of sph) if (s.klass !== "star") notSky.add(s.index);
                    const skyCount = solved.tracks.length - notSky.size;
                    if (skyCount >= 8) {
                        const tSph2 = Date.now();
                        updateProgress({percent: 98, status: "Re-solving on stars only"});
                        await yieldToBrowser();
                        const re = await solveSky(refined.states, notSky,
                            {status: "Re-solving on stars only", stage: "Re-solving on stars only"},
                            98, 1.0);
                        if (!re) {
                            params.status = aborted ? "aborted" : "cancelled (video changed)";
                            return null;
                        }
                        refined = re;
                        console.log(`[StarTrack] ${fixedCam ? "refineFixedAxisSpherical" : "refineGlobalSpherical"}#2 `
                            + `${Date.now() - tSph2}ms (${refined.iterations} iterations, `
                            + `converged=${refined.converged})`);
                        sph = classifyTracksSpherical(solved.tracks, refined.states, lens, size,
                            {...classifyOpts, exclude: notSky});
                    }

                    // Overwrite only the VERDICT and the numbers behind it. position, magnitude,
                    // rx/ry and everything the overlay and Identify read stay on the 2D chart.
                    let changed = 0;
                    for (const s of sph) {
                        const c = solved.classified[s.index];
                        if (!c) continue;
                        if (c.klass === "cameraFixed") continue;   // the 2D pass owns this verdict
                        if (c.klass !== s.klass) changed++;
                        // Keep the 2D verdict. Star IDENTIFICATION still consumes the 2D
                        // reference chart and is calibrated against the star set that chart
                        // produced; handing it the ~60 extra edge stars this fix recovers breaks
                        // its match consensus (measured on the reference clip: identify succeeded
                        // before, failed after). Until Identify is migrated to the spherical map
                        // it keeps the input it was tuned for. This decouples the two features
                        // rather than trading one regression for another. (A KNOWN fisheye lens
                        // is the exception - its 2D chart is meaningless, so identifyStars
                        // charts the sphere instead; see sphereIdentifyChart.)
                        c.klass2D = c.klass;
                        c.klass = s.klass;
                        c.totalDrift = s.totalDrift;
                        c.significance = s.significance;
                        c.sigma = s.sigma;
                    }
                    // A flat gnomonic chart of the settled map, for the star IDENTIFIER.
                    //
                    // Identify hashes quads with a planar-similarity-invariant code and verifies
                    // against a gnomonic field, so it needs a chart where great circles are
                    // straight. The 2D reference chart is not one - it carries the same edge warp
                    // that made the classification wrong - and handing it 60-odd newly-recovered
                    // EDGE stars, which is exactly what this feature does, pushed it past the
                    // point where it could hold consensus. Measured: identify succeeded before
                    // this change and failed after it, on the same clip.
                    const chartOut = gnomonicChart(solved.tracks.map((t) => t.ref), lens.focalPx);
                    const chart = chartOut.positions;

                    const fov = lensFOV(lens, size);
                    lensInfo = {lens, diagnostics: cal.diagnostics, changed, rms: refined.rms,
                        chart, chartCentre: chartOut.centre, states: refined.states,
                        // The render's roll is not part of the lens (the per-frame orientation
                        // absorbs it); the camera sync puts it back. Zero for a fitted lens.
                        rollDeg: knownLens ? fisheye.roll : 0};
                    const lensLabel = knownLens
                        ? `fisheye (Camera menu) ${LENS_PRESETS[lens.type]?.label ?? lens.type}`
                        : lens.type;
                    let fixedNote = "";
                    if (fixedCam && refined.axis) {
                        // The fitted rate against the sidereal rate gives the exposure interval
                        // the timeline implies - a check on the timelapse, not an assumption of
                        // it. The rotation axis is the celestial pole; whichever of its two ends
                        // lies in front of the camera is the one the footage can show.
                        const rateDeg = refined.ratePerFrame * 180 / Math.PI;
                        const siderealDegPerSec = 360 / 86164.0905;
                        const secondsPerFrame = rateDeg / siderealDegPerSec;
                        const ax = refined.axis;
                        const front = ax[2] >= 0 ? ax : [-ax[0], -ax[1], -ax[2]];
                        const polePx = rayToPixel(lens, front, size);
                        lensInfo.fixedAxis = {axis: ax, ratePerFrameDeg: rateDeg, secondsPerFrame,
                            polePx, f0: refined.f0};
                        fixedNote = `; fixed camera, sky ${rateDeg.toFixed(4)} deg/frame`
                            + ` (${secondsPerFrame.toFixed(1)} s/frame)`;
                        console.log(`[StarTrack] fixed camera: rate ${rateDeg.toFixed(5)} deg/frame = `
                            + `${secondsPerFrame.toFixed(2)} s/frame at the sidereal rate; celestial pole at `
                            + (polePx ? `(${polePx[0].toFixed(1)}, ${polePx[1].toFixed(1)}) px` : "no image")
                            + ` in analysed frame ${refined.f0}`);
                    }
                    // A known lens is described by its image circle, as the Camera menu does;
                    // lensFOV's frame-edge figure would quote the model well past the circle.
                    const fovNote = knownLens ? `${fisheye.fov.toFixed(1)} deg circle` : `${fov.hfov.toFixed(0)} deg`;
                    params.lensStatus = `${lensLabel}, ${fovNote}, rms ${refined.rms.toFixed(2)} px`
                        + (changed ? `, ${changed} reclassified` : "") + fixedNote;
                } else {
                    params.lensStatus = `not fitted: ${cal.reason}`;
                }
            } catch (e) {
                // A calibration failure must never take the whole analysis down with it - the 2D
                // result above is still a usable answer.
                console.warn("Star Track lens calibration failed", e);
                params.lensStatus = "failed (see console)";
            }
        } else if (!params.fitLens) {
            params.lensStatus = "off";
        }

        // Stage 4: the lights that move TOGETHER - an aircraft's flashing cluster - grouped into
        // objects that no individual track is good enough to establish. Meaningless for a
        // still: motion is the one thing a single exposure cannot show.
        updateProgress({percent: 99, status: "Grouping moving clusters"});
        await yieldToBrowser();
        const sigma = solved.classified.find((c) => c.sigma)?.sigma ?? 1;
        const clusters = still ? [] : groupMovingClusters(solved.tracks, solved.classified,
            solved.transforms, sigma, {...ctx.calSolve, ...ctx.calCluster});

        // Reference-frame positions of every observation, recomputed against the FINAL transforms.
        // The rx/ry stored during association were measured against the first refinement, and the
        // star-only re-solve moves the map afterwards - drawing a mover from those stale
        // coordinates displaces its marker from the object it is meant to be circling.
        for (const t of solved.tracks) {
            for (const o of t.obs) {
                const T = solved.transforms[o.f];
                if (!T) continue;
                const inv = invertTransform(T);
                if (!inv) continue;
                const [rx, ry] = applyTransform(inv, o.x, o.y);
                o.rx = rx; o.ry = ry;
            }
        }

        // The camera options registered by Sync Camera rest on the PREVIOUS solve - its
        // refToSky, its plate scale. Detach them before the result they describe is replaced,
        // or the heading stays selected but inert (the fresh result has no identify yet) and
        // the FOV keeps serving the old solve's zoom.
        detachStarTrackCamera();
        result = {frame0, frame1: analysedLast, generation, videoData, perFrame, chain, solved,
            clusters, videoW, videoH, still, rejectCounts, rejectSamples, lensInfo,
            stoppedEarly: analysedLast < lastFrame};
        // Published for inspection and for other tools, the way camera motion publishes its own
        // per-video data on Globals.
        Globals.starTrackerResult = result;
        // The lens is a CAMERA property, so it is reported in the Camera menu too - and cleared
        // there when this run did not fit one, rather than leaving the previous clip's optics on
        // screen describing footage that is no longer loaded.
        updateCameraLensMenu(lensInfo, [videoW, videoH]);
        const counts = {};
        for (const c of solved.classified) counts[c.klass] = (counts[c.klass] || 0) + 1;
        params.status = still
            ? `${counts.star || 0} stars (still image)`
            : `${counts.star || 0} stars, ${counts.moving || 0} moving`
                + (clusters.length ? `, ${clusters.length} light cluster${clusters.length > 1 ? "s" : ""}` : "")
                + `, sigma ${solved.classified[0] ? solved.classified[0].sigma.toFixed(2) : "?"} px`
                // Said out loud: these numbers came from part of the clip, and a reader comparing
                // them with a full pass needs to know that without going back to the console.
                + (result.stoppedEarly ? ` (stopped early, ${analysedLast - frame0 + 1}/${total} frames)` : "");
        ensureOverlay();
        completed = true;
        return result;
    } finally {
        running = false;
        // Hand the overlay back to the finished result (or to nothing). Cleared before the final
        // render below, or the preview's last frame would sit on screen over the real answer.
        liveDetections = null;
        liveStage = null;
        if (!quiet) hideProgress();
        // Release before touching par.paused, or the lock refuses our own restore.
        par.pausedLock = false;
        if (Globals.loadGeneration === generation) {
            // Park on the first analysed frame rather than wherever the user was: that frame is
            // the start of what was just measured, and the overlay is drawn for it. An abort
            // produced nothing to look at, so that case goes back where it came from.
            par.frame = completed ? frame0 : savedFrame;
        }
        // Stay paused after a completed run. Restoring "was playing" would immediately run the
        // video away from the frame we just parked on, which is the opposite of useful. This holds
        // for a quiet scoring run too: analysis is a "stop and look at this frame" operation, and
        // that is as true when a search asked for it as when the user did.
        if (!completed) par.paused = wasPaused;
        setRenderOne();
    }
}

// The view whose renderCanvas we have patched. Held as the view itself rather than a boolean:
// loading a new sitch builds a NEW video view, and a boolean would report the patch as installed
// while the new view went unhooked, leaving the overlay frozen on the last drawn frame.
let hookedView = null;

// The star circles as drawn THIS frame, in overlay-canvas pixels: {x, y, r, index}. Rebuilt on
// every overlay draw, so click hit-testing always tests against exactly what is on screen - the
// same transform, rescale and visibility filters, with no second copy of the mapping to drift.
let overlayStarHits = [];

/** ALL drawn star circles containing this overlay-canvas point - a click toggles every one of
 * them, so a tight clump of overlapping circles goes in one click instead of one per circle. */
function starHitsAt(px, py) {
    return overlayStarHits.filter((h) => Math.hypot(px - h.x, py - h.y) <= h.r + 3);
}

/**
 * Toggle the clicked stars in or out of the working set: dimmed on the overlay, excluded from
 * Identify. One click, one outcome: if ANY of the clicked circles is still enabled the click
 * disables them all, otherwise it re-enables them all - a clump in mixed states unifies rather
 * than each circle flipping independently, which would swap the states forever without ever
 * reaching "all off".
 */
function toggleStarsEnabled(indices) {
    if (!result || !indices.length) return;
    if (!result.disabledStars) result.disabledStars = new Set();
    const editedResult = result, before = [...result.disabledStars];
    const disableAll = indices.some((ix) => !result.disabledStars.has(ix));
    for (const ix of indices) {
        if (disableAll) result.disabledStars.add(ix);
        else result.disabledStars.delete(ix);
    }
    const after = [...result.disabledStars];
    const restore = state => { editedResult.disabledStars = new Set(state); setRenderOne(); };
    UndoManager.add({description: "Toggle star selection", undo: () => restore(before), redo: () => restore(after)});
    setRenderOne();
}

/** The overlay canvas, created lazily over the video view, and hooked to redraw each frame. */
function ensureOverlay() {
    const view = videoView();
    if (!view || !view.div) return false;

    if (!overlay || overlay.parentNode !== view.div) {
        overlay = document.createElement("canvas");
        overlay.style.cssText =
            "position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:100";
        view.div.appendChild(overlay);
        overlayCtx = overlay.getContext("2d");
    }

    if (!view._starTrackInteraction) {
        const hits = e => {
            const rect = overlay.getBoundingClientRect();
            return starHitsAt(e.clientX - rect.left, e.clientY - rect.top).map(h => h.index);
        };
        let clicked = [];
        view._starTrackInteraction = registerSurfaceInteraction(view.canvas, {
            model: view, view, content: false, profile: "stars",
            enabled: () => !!result && !!overlay && overlay.parentNode === view.div,
            intent: {kind: "pending", priority: 30},
            hitTest: e => hits(e).length ? {} : null,
            begin: e => { clicked = hits(e); },
            click: () => toggleStarsEnabled(clicked),
        });
    }

    // Redraw after the view has painted the frame, so the circles land on the frame they describe.
    if (hookedView !== view && typeof view.renderCanvas === "function") {
        hookedView = view;
        const original = view.renderCanvas.bind(view);
        view.renderCanvas = (frame) => {
            original(frame);
            // While a run is scanning, the live preview OWNS the overlay. `result` may still hold
            // the previous analysis, and letting it paint here would fight the preview frame by
            // frame - two different passes' circles alternating on screen.
            if (liveDetections) drawLiveDetections();
            else if (liveStage) drawLiveStage();
            else if (result) drawStarTrackerOverlay();
        };
    }
    return true;
}

const COLORS = {
    star: "#2bff7a",
    moving: "#ff2a2a",
    cameraFixed: "#ffc400",
    incoherent: "#8a8a8a",
    cluster: "#ff9500",
    // Transient views of the solver working, deliberately unlike any classification colour: none
    // of these is a verdict about anything on screen.
    quad: "#4db8ff",
    lens: "#ff5edb",
    sphere: "#7cf6ff",
};

// One light colour per drawn quad, so five overlapping four-star shapes can be told apart - they
// share stars and cross each other, and in a single colour they read as one tangle. Green and red
// are avoided throughout: those mean "star" and "moving" everywhere else on this overlay.
const QUAD_COLORS = ["#7cf6ff", "#ffd866", "#ff9ecd", "#b8a6ff", "#ffb38a"];

// How many star circles are drawn at full strength. A dense field solves thousands of stars - 882
// on the Milky Way timelapse this was tuned against - and at full weight the overlay becomes a
// wall of green that hides the footage it is annotating. The rest are still drawn, because "why is
// that star not circled" has to stay answerable by looking, just quietly enough to see through.
const BRIGHT_CIRCLES = 100;

let brightCutoffFor = null, brightCutoffMag = Infinity;

/**
 * The magnitude at which a star stops being drawn at full strength: the BRIGHT_CIRCLES'th
 * brightest, or Infinity when there are few enough to show them all.
 *
 * Cached against the result object's identity rather than recomputed per frame - this is a render
 * loop, and the sort plus its temporary array would otherwise run at frame rate for an answer that
 * only changes when a new analysis replaces the old one.
 */
function brightMagnitudeCutoff() {
    if (brightCutoffFor === result) return brightCutoffMag;
    const mags = [];
    for (const c of result.solved.classified) {
        if (c.klass === "star" && Number.isFinite(c.magnitude)) mags.push(c.magnitude);
    }
    mags.sort((a, b) => a - b);          // astronomical convention: SMALLER is brighter
    brightCutoffMag = mags.length > BRIGHT_CIRCLES ? mags[BRIGHT_CIRCLES - 1] : Infinity;
    brightCutoffFor = result;
    return brightCutoffMag;
}

/**
 * Draw the classification over the video for the current frame.
 *
 * Circles are placed from the SOLVED star map rather than from that frame's detections, so they
 * stay put through a frame where a star was missed - which is the whole point of having solved the
 * camera motion. Radius comes from the measured magnitude.
 */
/**
 * Draw the raw detections of the frame currently being measured, during a run.
 *
 * Deliberately plain, and deliberately different from the finished overlay: nothing has been
 * solved yet, so there is no classification, no magnitude tiering, no name and no click target.
 * Every accepted blob draws the same small ring, which is an honest picture of what the detector
 * is handing the solver - and makes a bad threshold or blob-size setting obvious while the pass
 * is still running, rather than after minutes of waiting.
 *
 * Circles come from THIS frame's detections, so a star missed on one frame simply is not circled
 * on it. That is the opposite of the finished overlay, which places circles from the solved map
 * precisely so they stay put through a missed frame.
 */
function drawLiveDetections() {
    const view = videoView();
    if (!view || !overlay || !overlayCtx || !liveDetections) return;

    const rect = view.div.getBoundingClientRect();
    if (overlay.width !== rect.width || overlay.height !== rect.height) {
        overlay.width = rect.width;
        overlay.height = rect.height;
    }
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    // Nothing here is clickable - there are no solved stars to toggle yet - so any hits left over
    // from a previous result must not stay live under the preview.
    overlayStarHits = [];

    // The detections belong to one frame. The render loop paints frames the scan has already moved
    // past, so drawing them on any other frame would show last frame's circles against this one.
    // The pipelined analysis keeps this exact: it advances par.frame per FINISHED frame, together
    // with liveDetections, while its decode runs ahead without touching the playhead.
    if (Math.round(par.frame) !== liveDetections.frame) return;

    // Same rescale as the finished overlay: the analysis works in the DECODED pixel space, which
    // is a user setting and may differ from the view's current decode size.
    const rsx = liveDetections.W ? view.videoWidth / liveDetections.W : 1;
    const rsy = liveDetections.H ? view.videoHeight / liveDetections.H : 1;

    overlayCtx.strokeStyle = COLORS.star;
    overlayCtx.lineWidth = 1.2;
    overlayCtx.globalAlpha = 0.85;
    overlayCtx.setLineDash([]);
    for (const s of liveDetections.sources) {
        const [px, py] = view.videoToCanvasCoords(s.x * rsx, s.y * rsy);
        if (px < -20 || py < -20 || px > overlay.width + 20 || py > overlay.height + 20) continue;
        overlayCtx.beginPath();
        overlayCtx.arc(px, py, 7, 0, Math.PI * 2);
        overlayCtx.stroke();
    }
    overlayCtx.globalAlpha = 1;

    overlayCtx.fillStyle = COLORS.star;
    overlayCtx.font = "bold 13px sans-serif";
    overlayCtx.fillText(`${liveDetections.sources.length} detected`, 10, 20);
}

/**
 * Draw what the current whole-clip solve stage is computing.
 *
 * These stages have no per-frame progress to report - the lens fit and the spherical refinement
 * each solve over the entire clip at once - so a bar would be inventing a granularity that does
 * not exist. What is drawn instead is the stage's own working state.
 */
/**
 * Wipe the overlay now, rather than waiting for something to redraw it.
 *
 * The draw paths only run when they have something to draw, so dropping their state stops the
 * REDRAW but leaves whatever was last painted on screen - stale circles outliving the stage that
 * produced them. Whoever clears the state clears the canvas.
 */
function clearOverlayCanvas() {
    if (overlay && overlayCtx) overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    overlayStarHits = [];
}

function drawLiveStage() {
    const view = videoView();
    if (!view || !overlay || !overlayCtx || !liveStage) return;

    const rect = view.div.getBoundingClientRect();
    if (overlay.width !== rect.width || overlay.height !== rect.height) {
        overlay.width = rect.width;
        overlay.height = rect.height;
    }
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    overlayStarHits = [];
    overlayCtx.setLineDash([]);

    if (liveStage.kind === "lens") {
        // The optical axis, in the analysed frame's pixels. On cropped footage this walks a long
        // way from the frame centre, which is the whole reason the stage exists - so the crosshair
        // is drawn against a marker at the centre, making the offset the visible quantity.
        const [w, h] = liveStage.size || [0, 0];
        const rsx = w ? view.videoWidth / w : 1;
        const rsy = h ? view.videoHeight / h : 1;
        const [cx, cy] = view.videoToCanvasCoords((w / 2) * rsx, (h / 2) * rsy);
        const [ax, ay] = view.videoToCanvasCoords(liveStage.principal[0] * rsx,
            liveStage.principal[1] * rsy);

        overlayCtx.strokeStyle = "#8899aa";
        overlayCtx.lineWidth = 1;
        overlayCtx.setLineDash([3, 3]);
        overlayCtx.beginPath();
        overlayCtx.moveTo(cx, cy);
        overlayCtx.lineTo(ax, ay);
        overlayCtx.stroke();
        overlayCtx.setLineDash([]);

        // Settled draws solid and bright; a candidate mid-search draws lighter, so the moment the
        // search stops wandering and commits is visible without reading the text.
        const settled = liveStage.stage === "refined";
        overlayCtx.strokeStyle = COLORS.lens;
        overlayCtx.globalAlpha = settled ? 1 : 0.6;
        overlayCtx.lineWidth = settled ? 2.5 : 1.5;
        const r = settled ? 22 : 15;
        overlayCtx.beginPath();
        overlayCtx.arc(ax, ay, r, 0, Math.PI * 2);
        overlayCtx.moveTo(ax - r * 1.6, ay);
        overlayCtx.lineTo(ax + r * 1.6, ay);
        overlayCtx.moveTo(ax, ay - r * 1.6);
        overlayCtx.lineTo(ax, ay + r * 1.6);
        overlayCtx.stroke();
        overlayCtx.globalAlpha = 1;

        const dx = Math.round(liveStage.principal[0] - w / 2);
        const dy = Math.round(liveStage.principal[1] - h / 2);
        const bits = [`optical axis ${dx >= 0 ? "+" : ""}${dx}, ${dy >= 0 ? "+" : ""}${dy} px from centre`];
        if (Number.isFinite(liveStage.rms)) bits.push(`rms ${liveStage.rms.toFixed(2)}`);
        if (liveStage.within !== undefined && liveStage.pairs) {
            bits.push(`${liveStage.within}/${liveStage.pairs} pairs`);
        }
        if (liveStage.focalPx) bits.push(`f ${Math.round(liveStage.focalPx)} px`);
        overlayCtx.fillStyle = COLORS.lens;
        overlayCtx.font = "bold 13px sans-serif";
        overlayCtx.fillText(settled ? "lens fitted" : "fitting camera lens", 10, 20);
        overlayCtx.font = "12px sans-serif";
        overlayCtx.fillText(bits.join("  -  "), 10, 38);
        return;
    }

    if (liveStage.kind === "sphere") {
        // Numbers, not a chart. A residual trace over 4-12 points with no axes says only "it went
        // down", which the iteration counter already implies - the question a viewer actually has
        // is "is this nearly finished, or stuck?", and that is answered by the STOPPING TEST: the
        // loop ends when the per-iteration step falls below the tolerance. So the step and the
        // tolerance are shown side by side, and how far the residual has come from where it began.
        overlayCtx.fillStyle = COLORS.sphere;
        overlayCtx.font = "bold 13px sans-serif";
        overlayCtx.fillText(liveStage.title, 10, 20);
        overlayCtx.font = "12px sans-serif";
        overlayCtx.fillText([`iteration ${liveStage.iteration}/${liveStage.iterations}`,
            liveStage.phase ? `phase: ${liveStage.phase}` : null,
        ].filter(Boolean).join("  -  "), 10, 38);

        if (Number.isFinite(liveStage.rms)) {
            const from = Number.isFinite(liveStage.first) && liveStage.first !== liveStage.rms
                ? ` (from ${liveStage.first.toFixed(3)})` : "";
            overlayCtx.fillText(`residual ${liveStage.rms.toFixed(4)} px${from}`, 10, 56);
        }
        if (Number.isFinite(liveStage.step) && Number.isFinite(liveStage.tolerance)) {
            const done = liveStage.step < liveStage.tolerance;
            overlayCtx.fillStyle = done ? COLORS.star : COLORS.sphere;
            overlayCtx.fillText(
                `step ${liveStage.step.toExponential(1)} `
                + `${done ? "<" : "vs"} ${liveStage.tolerance.toExponential(0)} to stop`, 10, 74);
        }
    }
}

export function drawStarTrackerOverlay() {
    if (!result) return;
    const view = videoView();
    // A solve belongs to one video. Loading a different video into the SAME view leaves the view
    // identity unchanged, so without comparing videoData the previous video's star map would go on
    // being painted over the new footage - and published on Globals as if it described it.
    if (!view || view.videoData !== result.videoData
        || Globals.loadGeneration !== result.generation) {
        resetStarTracker();
        return;
    }
    if (!ensureOverlay()) return;
    const rect = view.div.getBoundingClientRect();
    if (overlay.width !== rect.width || overlay.height !== rect.height) {
        overlay.width = rect.width;
        overlay.height = rect.height;
    }
    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    // Cleared with the canvas, not inside the star loop: any early return below leaves the
    // screen empty, and an empty screen must not keep last frame's invisible circles clickable.
    overlayStarHits = [];

    const i = Math.round(par.frame) - result.frame0;
    const T = result.solved.transforms[i];
    if (!T) return;

    // The analysis lives in the DECODED pixel space of its run - and the decode size is a user
    // setting (Settings > Performance Tweaks > Max Resolution), so a 4K source may have been
    // analysed at 1080P or 720P, and the setting can change after the run. Coordinates are
    // therefore rescaled from the analysed frame size to the CURRENT decoded size before the
    // display mapping; when nothing changed the factor is one.
    const rsx = result.videoW ? view.videoWidth / result.videoW : 1;
    const rsy = result.videoH ? view.videoHeight / result.videoH : 1;
    const toCanvas = (vx, vy) => view.videoToCanvasCoords(vx * rsx, vy * rsy);

    // WHERE A CIRCLE GOES, and why there are two answers.
    //
    // The 2D similarity `T` has four degrees of freedom - one rotation, one uniform scale, one
    // shift - so it moves the whole field of circles RIGIDLY. It cannot bend, and a wide lens
    // bends: theta(rho) is nonlinear, so one sky rotation moves an edge star a different number
    // of PIXELS than a centre star. A similarity has one scale for the whole image, so it can
    // only be right at one radius and its error grows outward from the optical axis. Measured on
    // the cropped Starlink clip at frame 84, median error against the actual detections:
    //
    //     distance from optical axis    0-200   200-400   400-600   600-800   800-1000
    //     placed by the 2D similarity    0.30      0.39      3.10      7.42      11.35   px
    //     placed on the sphere           0.17      0.19      0.23      0.17       0.33   px
    //
    // with a worst case of 23.7 px against 0.89 px. Circle radii are 6-24 px, so out at the edge
    // the 2D model misses by a full circle width - the reported symptom, and asymmetric on a
    // cropped clip because the optical axis is not the frame centre. Adding degrees of freedom
    // does not rescue it: a homography measured 11.4 px against the similarity's 11.7, because
    // K R K^-1 models perspective and radial compression is not a projective map.
    //
    // So stars are placed from their own settled DIRECTION through that frame's solved
    // ORIENTATION whenever the lens was fitted, and the 2D chart remains the fallback for runs
    // where it was not. Star IDENTIFICATION is deliberately NOT moved with them - it consumes
    // the 2D chart and is calibrated against the star set that chart produced.
    const lensInfo = result.lensInfo;
    const sphStates = lensInfo && lensInfo.states;
    const sphState = sphStates ? sphStates[i] : null;
    const sphSize = [result.videoW, result.videoH];

    let magMin = Infinity, magMax = -Infinity;
    for (const c of result.solved.classified) {
        if (!Number.isFinite(c.magnitude)) continue;
        if (c.magnitude < magMin) magMin = c.magnitude;
        if (c.magnitude > magMax) magMax = c.magnitude;
    }
    // When every magnitude is the SAME finite value the range stays empty and the radius
    // formula's magMax > magMin guard falls through to its mid-size default. Substituting an
    // arbitrary range here instead would put that one real magnitude OUTSIDE it, drive the
    // radius negative, and abort the whole overlay when arc() throws.

    const brightCutoff = brightMagnitudeCutoff();

    for (const c of result.solved.classified) {
        if (!c.position) continue;
        if (c.klass === "short") continue;
        // A star is dropped only when NEITHER of its two layers is wanted. "Show star markers"
        // governs the circle alone, so with it off and names on the label still has to be placed,
        // which needs the star's position computed exactly as before.
        if (c.klass === "star" && !params.showStars && !params.showStarNames) continue;
        if (c.klass === "moving" && !params.showMoving) continue;
        if ((c.klass === "incoherent" || c.klass === "cameraFixed") && !params.showRejected) continue;

        const track = result.solved.tracks[c.index];
        let rx = c.position[0], ry = c.position[1];
        // `point` is the spherical placement; `noImage` distinguishes "the lens says this ray
        // falls outside what the camera can see in this frame", which must skip the circle, from
        // "there was nothing to project", which falls back to the 2D chart.
        let point = null, noImage = false;

        if (c.klass === "moving") {
            // Only while the track is actually following the object: the nearest-observation
            // mapping below would happily carry its position to every OTHER frame too, pinning
            // a red circle to the sky before the object appears and after it has gone.
            if (i < c.first || i > c.last) continue;
            // A mover has no fixed map position, so show it where it actually was in the nearest
            // frame it was seen, brought into this frame through the solved transform.
            const o = track.obs.reduce((a, b) => (Math.abs(b.f - i) < Math.abs(a.f - i) ? b : a));
            rx = o.rx; ry = o.ry;
            // On the sphere the same hop is pixel -> ray in the frame it was SEEN -> pixel in
            // this one. A mover's `ref` is a single settled direction and using it would pin the
            // marker still, which is exactly the motion the red circle exists to show.
            if (sphState && sphStates[o.f]) {
                point = framePixelToFrame(sphStates[o.f], sphState, lensInfo.lens, o.x, o.y, sphSize);
                noImage = !point;
            }
        } else if (sphState && track && track.ref) {
            point = refToFrame(sphState, lensInfo.lens, track.ref, sphSize);
            noImage = !point;
        }

        // Skipping is the honest answer to "this star has no image in this frame". The 2D model
        // always returned a point, which is how a circle ends up drawn where the star cannot be.
        if (noImage) continue;
        const [vx, vy] = point || applyTransform(T, rx, ry);
        // Display-space mapping, not videoToCanvasCoordsOriginal: that one expects ORIGINAL
        // source coordinates, and on a 4K clip decoded at a capped resolution it compresses
        // every circle toward the top-left, parting them from their stars.
        const [px, py] = toCanvas(vx, vy);
        if (px < -40 || py < -40 || px > overlay.width + 40 || py > overlay.height + 40) continue;

        const t01 = Number.isFinite(c.magnitude) && magMax > magMin
            ? (magMax - c.magnitude) / (magMax - magMin) : 0.5;
        const radius = 6 + t01 * 18;

        // A star the catalog gave a PROPER name - Pollux, Deneb - is always drawn at full
        // strength however faint it measured. The name is the whole point of annotating it, and
        // a label at quarter opacity over video is unreadable. Bayer designations and HIP
        // numbers do not qualify: those are catalog identifiers rather than names, and nearly
        // every match has one, so honouring them would defeat the tiering entirely.
        const identifiedStar = c.klass === "star" && result.identify
            ? result.identify.identified.get(c.index)
            : null;
        const properlyNamed = !!identifiedStar?.named;

        // Everything below the brightest BRIGHT_CIRCLES draws as a thin, faint ring. An
        // UNMEASURED magnitude counts as faint - a star with no photometry cannot claim to be in
        // the top hundred. Only stars are demoted: movers are the point of the analysis and there
        // are few of them, and the rejected classes are off by default anyway.
        const faint = c.klass === "star"
            && !properlyNamed
            && !(Number.isFinite(c.magnitude) && c.magnitude <= brightCutoff);

        // Stars are clickable: register the circle as drawn, and dim a toggled-off star - still
        // visible enough to click back on, clearly out of the working set. The disabled and faint
        // states are multiplied rather than merged so BOTH stay readable: a faint star still
        // visibly changes when it is toggled off. Movers draw at half strength so the circle and
        // its label mark the object without painting over it.
        const disabled = c.klass === "star" && result.disabledStars?.has(c.index);
        // The circle is what the user clicks, so the hit follows the circle rather than the star:
        // with the markers hidden there is nothing to aim at, and a registered hit would toggle a
        // star out of the working set on a click that appeared to land on empty sky.
        const drawMarker = c.klass !== "star" || params.showStars;
        if (c.klass === "star" && drawMarker) {
            overlayStarHits.push({x: px, y: py, r: radius, index: c.index});
        }
        const alpha = disabled
            ? (faint ? 0.15 : 0.3)
            : (faint ? 0.25 : c.klass === "moving" ? 0.5 : 1);
        if (alpha !== 1) overlayCtx.globalAlpha = alpha;

        if (drawMarker) {
            overlayCtx.beginPath();
            overlayCtx.arc(px, py, radius, 0, Math.PI * 2);
            overlayCtx.strokeStyle = COLORS[c.klass] || "#888";
            overlayCtx.lineWidth = c.klass === "moving" ? 3 : faint ? 1 : 1.8;
            overlayCtx.setLineDash(c.klass === "incoherent" ? [4, 4] : []);
            overlayCtx.stroke();
        }

        if (c.klass === "moving") {
            overlayCtx.setLineDash([]);
            overlayCtx.fillStyle = COLORS.moving;
            overlayCtx.font = "bold 13px sans-serif";
            overlayCtx.fillText(`moves ${c.totalDrift.toFixed(0)} px vs stars`, px + radius + 6, py + 4);
        }

        // Identified stars carry their catalog names. A star with a PROPER name reads a
        // touch larger and in white; Bayer and HIP-number fallbacks stay quiet.
        if (params.showStarNames && identifiedStar) {
            overlayCtx.setLineDash([]);
            overlayCtx.fillStyle = properlyNamed ? "#fff" : "#9fdcb0";
            overlayCtx.font = properlyNamed ? "12px sans-serif" : "11px sans-serif";
            // Clear of the circle when there is one; a bright star's circle is 24 px, and holding
            // that offset with the markers hidden would strand the name far from its star.
            overlayCtx.fillText(identifiedStar.label, px + (drawMarker ? radius + 4 : 6), py + 4);
        }
        if (alpha !== 1) overlayCtx.globalAlpha = 1;
    }

    // Light clusters - several lights moving together, no one of them trackable on its own.
    // Drawn from the ensemble's motion model, clamped to its lifetime so the ring rides the
    // object between flashes rather than extrapolating off into the dark.
    if (params.showClusters && result.clusters) {
        for (const cl of result.clusters) {
            if (i < cl.first - 3 || i > cl.last + 3) continue;
            const [rx, ry] = cl.at(Math.min(Math.max(i, cl.first), cl.last));
            // Still the 2D placement, deliberately. A cluster's motion model lives in
            // reference-chart coordinates, and there is no chart-to-direction map to carry it
            // onto the sphere - the chart is a chain of similarities, not a projection of one.
            // The edge error it inherits is small against a ring whose radius is the formation's
            // own extent (>= 20 px), so this is a real limitation but not a visible one.
            const [vx, vy] = applyTransform(T, rx, ry);
            const [px, py] = toCanvas(vx, vy);
            if (px < -80 || py < -80 || px > overlay.width + 80 || py > overlay.height + 80) continue;
            // The ring's radius is the formation extent, mapped through the same video-to-canvas
            // scaling as the position so it hugs the same pixels at any window size.
            const [ex, ey] = toCanvas(vx + cl.extent + 10, vy);
            const radius = Math.max(20, Math.hypot(ex - px, ey - py));
            overlayCtx.beginPath();
            overlayCtx.arc(px, py, radius, 0, Math.PI * 2);
            overlayCtx.strokeStyle = COLORS.cluster;
            overlayCtx.lineWidth = 2.5;
            overlayCtx.setLineDash([8, 5]);
            overlayCtx.stroke();
            overlayCtx.setLineDash([]);
            overlayCtx.fillStyle = COLORS.cluster;
            overlayCtx.font = "bold 13px sans-serif";
            overlayCtx.fillText(
                cl.lights >= 2
                    ? `${cl.lights} lights moving together, ${cl.totalDrift.toFixed(0)} px`
                    : `faint moving object, ${cl.totalDrift.toFixed(0)} px`,
                px + radius + 6, py + 4);
        }
    }

    // Quads the blind solve has verified, while it is still searching. Drawn last so they sit
    // over the star circles, and in the 2D chart placement because identification works on that
    // chart - the same reason the clusters above do.
    //
    // Line weight is the fraction of the whole field the hypothesis explains, which is the
    // honest measure of quality here: any accepted quad fits its own four points well, so
    // thickness by quad residual would draw every candidate the same. A wrong quad explains a
    // handful of stars and stays hairline; the winning one explains most of the field and is
    // unmistakable.
    if (params.showQuadLines && liveQuads.length) {
        liveQuads.forEach((q, qi) => {
            const sChart = result.sphereChart?.chart;
            const pts = q.points.map(([qx, qy]) => {
                // The solver codes each quad in both parities, and a mirrored hit carries
                // negated y. Undo that before drawing, or half the quads land reflected about
                // the chart's x-axis, nowhere near their stars.
                const cy = q.mirrored ? -qy : qy;
                // A sphere chart's quad comes back through the chart's projection and this
                // frame's orientation; the 2D chart's through the frame transform.
                let v;
                if (sChart && sphState) {
                    v = refToFrame(sphState, lensInfo.lens, sphereChartUnproject(sChart, qx, cy), sphSize);
                    if (!v) return [NaN, NaN];
                } else {
                    v = applyTransform(T, qx, cy);
                }
                return toCanvas(v[0], v[1]);
            });
            if (pts.some(([px, py]) => !Number.isFinite(px) || !Number.isFinite(py))) return;

            // Indexed from the END, so the strongest quad keeps the same colour whether one
            // survived or five did - the list is sorted worst-first and a short list would
            // otherwise re-colour everything.
            overlayCtx.strokeStyle =
                QUAD_COLORS[(liveQuads.length - 1 - qi) % QUAD_COLORS.length];
            overlayCtx.lineWidth = 0.8 + 5 * Math.min(1, Math.max(0, q.fraction));
            overlayCtx.globalAlpha = 0.55 + 0.45 * Math.min(1, Math.max(0, q.fraction));
            overlayCtx.setLineDash([]);
            // The quad as a closed shape through its four stars, plus both diagonals - the code
            // is built from the two most separated of them, and the diagonals make which pair
            // that is readable at a glance.
            overlayCtx.beginPath();
            for (let j = 0; j < 4; j++) {
                const [ax, ay] = pts[j];
                const [bx2, by2] = pts[(j + 1) % 4];
                overlayCtx.moveTo(ax, ay);
                overlayCtx.lineTo(bx2, by2);
            }
            overlayCtx.moveTo(pts[0][0], pts[0][1]);
            overlayCtx.lineTo(pts[2][0], pts[2][1]);
            overlayCtx.moveTo(pts[1][0], pts[1][1]);
            overlayCtx.lineTo(pts[3][0], pts[3][1]);
            overlayCtx.stroke();
            overlayCtx.globalAlpha = 1;
        });
        // What the strongest quad actually explains, so the number the thickness encodes is
        // legible and not merely suggestive.
        const best = liveQuads[liveQuads.length - 1];
        overlayCtx.fillStyle = QUAD_COLORS[0];
        overlayCtx.font = "bold 13px sans-serif";
        overlayCtx.fillText(`${liveQuads.length} best matching quad`
            + `${liveQuads.length > 1 ? "s" : ""} - `
            + `strongest explains ${best.matched}/${best.nImage} stars`, 10, 20);
    }

    overlayCtx.setLineDash([]);
}

/**
 * Discard the solve and clear the overlay. Called on sitch teardown and by the Clear button.
 *
 * `hookedView` is deliberately NOT cleared here. The renderCanvas wrapper is harmless with no
 * result - it checks before drawing - and clearing the marker would make the next analysis wrap
 * the already-wrapped function, so every Clear/Analyze cycle would add another overlay draw per
 * rendered frame. The wrapper is replaced only when the VIEW itself changes, which is the only
 * time a fresh one is needed.
 */
export function resetStarTracker() {
    // The camera options rest on the solve being discarded; remove them FIRST so the switches
    // fall back to a valid choice rather than a dangling one.
    detachStarTrackCamera();
    result = null;
    Globals.starTrackerResult = undefined;
    overlayStarHits = [];
    // The quads are evidence for a solve that no longer exists, and they are placed through its
    // transforms - keeping them would draw the old identification over whatever comes next.
    liveQuads = [];
    params.status = "not run";
    // The Camera menu's Lens folder described THAT solve's optics; with the solve gone it would
    // be stating a measurement nothing in the app still holds.
    updateCameraLensMenu(null);
    if (overlay && overlayCtx) overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
}

/**
 * Full teardown for a sitch change: drop the solve AND the GUI folder.
 *
 * The folder is not permanent, so the menu bar destroys it on teardown - after which the `if
 * (folder) return` guard in setup would see a stale truthy reference and decline to build a new
 * one, and the Star Tracker menu would simply not come back. The overlay belongs to the old
 * video view's div and goes with it.
 */
export function disposeStarTracker() {
    resetStarTracker();
    folder = null;
    overlay = null;
    overlayCtx = null;
    hookedView = null;
    // Calibration was measured on THIS sitch's video; the next sitch's plate scale is unknown.
    // A minArea that CAME from that calibration falls with it - leaving the measured value
    // behind while the apertures and gates revert to defaults would hand the next sitch the
    // same half-calibrated mismatch a failed recalibration must not create. A value the user
    // set by hand is a preference, not a measurement, and stays.
    calibration = null;
    calibrationVideoData = null;
    if (minAreaCalibrated) {
        params.minArea = STAR_DETECT_DEFAULTS.minArea;
        minAreaCalibrated = false;
    }
    minAreaChosen = false;
    minAreaController = null;
    threshSigmaController = null;
    // A calibration still in flight belongs to the departing sitch; without this, the next
    // sitch's first minArea edit would report cancelling work that no longer exists.
    calibrationPending = false;
}

/** The last solve, for callers that want the star map or the classification. */
export function getStarTrackerResult() {
    return result;
}

/**
 * The one-click path: calibrate on the current frame, analyze the In/Out range, identify the
 * stars against the catalog, and sync the camera to the solve.
 *
 * Each stage gates the next on what it actually produced, not on the shared module state: a
 * calibration whose context died (sitch/video changed mid-decode, or a newer calibration click
 * superseded it) returns false, a failed or aborted analysis returns null, and an identify that
 * found nothing leaves no solved.ok - in each case the chain stops so the stage's own failure
 * status stays on screen rather than being overwritten by the next stage's "run Analyze first"
 * complaint, and so a click's analysis and camera sync can never land on a video swapped in
 * after the click. A failed MEASUREMENT does not stop the chain: detectStarSize keeps the
 * previous (or default) parameters on failure precisely so the analysis remains runnable.
 */
async function runFullStarTracker() {
    if (!await detectStarSize()) return;
    const analyzed = await runStarTracker();
    setRenderOne();
    if (!analyzed) return;
    await identifyStars();
    if (analyzed.identify?.solved?.ok) syncCameraToStarTrack();
}

/**
 * Add the "Star Tracker" folder under Video.
 *
 * Idempotent, and a no-op without a video - the same guards the neighbouring motion-analysis
 * menus use, so a sitch with no video does not grow a dead folder.
 */
export function setupStarTrackerMenu() {
    if (!guiMenus.video) return;
    if (!NodeMan.exists("video")) return;
    // A folder whose DOM has gone was destroyed with the menu bar; treat it as absent rather than
    // letting a stale reference suppress the rebuild.
    if (folder && folder.domElement && folder.domElement.isConnected) return;
    folder = null;

    folder = guiMenus.video.addFolder("Star Tracker").close();

    folder.add({all: () => { runFullStarTracker(); }}, "all")
        .name("Full Analysis");
    // The same optimization the Video Adjustments folder offers, reachable from here as well: it
    // tunes the picture FOR this analysis, so this is where somebody about to run one looks for it.
    // The builder adds its own Enough / Abort / status alongside, so a run started here can also be
    // stopped here.
    starOptimizeMenuBuilder?.(folder, "Optimize Adjustments for Frame");
    const statusController = folder.add(params, "status").name("Status").listen().disable();
    // Status strings routinely outgrow the readout ("identify failed: round-0 rematch
    // collapsed" shows as "identify failed: round-...") so the full text rides the row's
    // hover tooltip. The VISIBLE menu rows are MenuMirror twins of this controller, not its
    // own DOM, and twins only copy a tooltip at creation - so each frame the title is
    // stamped onto every Status row currently displaying this status text (an unrelated
    // Status row can only collide when its text is identical, making the stamp a no-op in
    // meaning). The loop retires when this folder's own row leaves the document - a menu
    // rebuild spawns a fresh one.
    const statusInput = statusController.domElement?.querySelector?.("input");
    if (statusInput) {
        // A timer rather than requestAnimationFrame: rAF pauses in hidden tabs, and a hover
        // tooltip needs half-second freshness, not frame accuracy.
        let wasConnected = false;
        const timer = setInterval(() => {
            const connected = statusInput.isConnected;
            if (connected) wasConnected = true;
            if (wasConnected && !connected) {
                clearInterval(timer);
                return;
            }
            for (const row of document.querySelectorAll(".controller.string")) {
                if (row.querySelector(".name")?.textContent !== "Status") continue;
                const inp = row.querySelector("input");
                if (inp && inp.value === params.status && inp.title !== params.status) {
                    inp.title = params.status;
                }
            }
        }, 500);
    }

    folder.add(params, "useMask").name("Use mask")
        .tooltip("Ignore detections that fall inside the video mask, painted under Video > "
            + "Masking. Foliage, rooftops and OSD graphics detect as hundreds of bright blobs "
            + "that the solver would otherwise treat as stars. Masked detections are counted as "
            + "rejections, so nothing goes missing silently.");
    folder.add(params, "applyAdjustments").name("Apply adjustments")
        .tooltip("Analyse the frame as you SEE it, with the Video Adjustments applied - levels, "
            + "curves, sharpen, blur, brightness and the rest. Off analyses the raw decoded "
            + "frame instead, which can find stars that are not visible on screen, or miss ones "
            + "that only the adjustments bring out. Does nothing when no adjustments are set.");
    folder.add(params, "fitLens").name("Fit lens from stars")
        .tooltip("Fit the camera lens from the star field and judge motion on the sphere instead "
            + "of with a flat 2D model. On a wide-angle clip the flat model is biased at the frame "
            + "edges and reports edge stars as moving. Refuses to fit when the clip does not "
            + "constrain a lens, so it is safe to leave on.");
    folder.add(params, "fixedCamera").name("Fixed camera")
        .tooltip("The camera did not move, turn or zoom during the clip (a mounted allsky or "
            + "meteor camera). The sky then turns rigidly about one axis at one rate, so the "
            + "solver fits three numbers for the whole clip instead of an orientation per "
            + "frame - far more robust on a sparse or very wide field, and it reports the "
            + "exposure interval the fitted rate implies. Leave off for hand-held or panned "
            + "footage.");
    folder.add(params, "lensStatus").name("Lens").listen().disable();
    // The overlay switches, in the order they are reached for: the circles, the names beside
    // them, the solver's quad lines, then the less-used classes. Each gates exactly one layer.
    folder.add(params, "showStars").name("Show star markers").onChange(setRenderOne)
        .tooltip("Draw the circle round each identified star. Only the circles - the catalog "
            + "names and the quad lines have their own switches, so the names can be read over "
            + "clean video with every circle hidden.");
    folder.add(params, "showStarNames").name("Show star names").onChange(setRenderOne)
        .tooltip("Label each identified star with its catalog name. Works whether or not the "
            + "star markers are drawn.");
    folder.add(params, "showQuadLines").name("Show quad lines").onChange(setRenderOne)
        .tooltip("Draw the four-star shapes the blind solve matched against the catalog, with "
            + "line weight showing how much of the field each one explains. They are the visible "
            + "evidence for the identification; turn them off once you trust it.");
    folder.add(params, "showMoving").name("Show moving").onChange(setRenderOne);
    folder.add(params, "showClusters").name("Show light clusters").onChange(setRenderOne);
    folder.add(params, "showRejected").name("Show rejected").onChange(setRenderOne);
    folder.add(params, "showDuringAnalysis").name("Display during analysis")
        .tooltip("While an analysis is scanning, circle each frame's detections as they are "
            + "found. Nothing is solved yet at that point, so these are raw detections - every "
            + "one drawn the same, with no classification or names - which is what makes a bad "
            + "detect threshold or blob size obvious without waiting for the run to finish.");
    folder.add(params, "chartTracks").name("Chart: object tracks");

    const tweaks = folder.addFolder("Star Tracker Tweaks").close();

    tweaks.add(params, "autoSigma").name("Auto detect threshold")
        .tooltip("Measure the detection threshold from the footage before each run: probe "
            + "three spread frames at a permissive threshold and pick the level where the "
            + "blob count stops falling - above the noise face, below the damage line where "
            + "airglow swallows real stars. The slider below shows what was chosen; when the "
            + "frames are too sparse to read, the slider's own value stands.");
    threshSigmaController =
        tweaks.add(params, "threshSigma", 2, 10, 0.25).name("Detect threshold (sigma)");
    // A hand-edited value is a user preference, not a measurement - it must survive sitch
    // teardown, where a calibrated one falls with its calibration. The edit also invalidates
    // any calibration still awaiting its frame, or that request would land afterwards,
    // overwrite the user's choice, and mark it calibrated.
    minAreaController = tweaks.add(params, "minArea", 2, 40, 1).name("Min blob area (px)")
        .onFinishChange(() => {
            minAreaCalibrated = false;
            // Deliberate, so a Full Analysis will now run with it rather than quietly measuring
            // over it. Pressing Detect Star Size still overwrites it - that is what it is for.
            minAreaChosen = true;
            calibrationRequest++;
            // The cancelled request may never return; its "measuring" status is now ours to
            // clear, or it sits there describing work that no longer exists.
            if (calibrationPending) {
                calibrationPending = false;
                params.status = "calibration cancelled by edit";
            }
        });
    // Blob sizes depend on resolution, zoom and exposure, so the pixel-scale settings are
    // measurable rather than guessable - this measures them from the frame on screen.
    // measure:true - pressing this IS the request to re-measure, so it overwrites a blob size
    // however it was arrived at. The chained call inside Full Analysis deliberately does not.
    tweaks.add({cal: () => { detectStarSize({measure: true}); }}, "cal")
        .name("Detect Star Size (current frame)");
    tweaks.add(params, "minObservations", 3, 40, 1).name("Min detections per track");
    tweaks.add(params, "driftSignificance", 2, 20, 0.5).name("Moving: significance");
    tweaks.add(params, "driftMinSigmas", 2, 40, 1).name("Moving: min drift (sigma)");

    tweaks.add({run: async () => { await runStarTracker(); setRenderOne(); }}, "run")
        .name("Find Candidate Stars");
    tweaks.add({identify: () => { identifyStars(); }}, "identify")
        .name("Identify Stars (catalog)");
    tweaks.add({sync: () => { syncCameraToStarTrack(); }}, "sync")
        .name("Sync Camera to Star Field");
    tweaks.add({chart: () => { makeStarChart(); }}, "chart").name("Make Star Chart (PNG)");

    folder.add({clear: () => { resetStarTracker(); setRenderOne(); }}, "clear").name("Clear");
}
