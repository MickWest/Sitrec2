// Star Tracker: the app-facing layer over the pure Star Track pipeline.
//
// Everything the analysis actually does lives in StarDetect / StarMatch / StarSolve, which are
// pure and testable. This module owns only the parts that need the running app: reading decoded
// video frames, the menu, and the overlay drawn on the video view.
//
// The menu lives under Video, alongside the other motion-analysis tools.

import {FileManager, GlobalDateTimeNode, Globals, guiMenus, NodeMan, Sit, setRenderOne} from "../Globals";
import {getCelestialDirectionFromRaDec} from "../CelestialMath";
import {CNodeController} from "../nodes/CNodeController";
import {CNodeArray} from "../nodes/CNodeArray";
import {SITREC_APP} from "../configUtils";
import {CVideoImageData} from "../CVideoImageData";
import {par} from "../par";
import {abFrameRange} from "../TraverseAnalysisData";
import {hideProgress, initProgress, updateProgress} from "../CProgressIndicator";

import {STAR_DETECT_DEFAULTS, calibrateDetection, detectSources, rejectReason} from "./StarDetect";
import {applyTransform, invertTransform, solveFrameChain} from "./StarMatch";
import {STAR_SOLVE_DEFAULTS, solveStarField} from "./StarSolve";
import {STAR_CLUSTER_DEFAULTS, groupMovingClusters} from "./StarCluster";
import {
    STAR_IDENTIFY_DEFAULTS,
    buildQuadIndex,
    parseStarCatalog,
    parseStarNames,
    scalePriorFromFov,
    solveField,
} from "./StarIdentify";

let folder = null;
let overlay = null;
let overlayCtx = null;
let result = null;          // the last completed solve
let running = false;
let aborted = false;
// Measured pixel-scale parameters from "Detect Star Size", applied to subsequent analyses.
// Null means the hand-tuned defaults, which were measured on the reference footage.
let calibration = null;
let minAreaController = null;
// Whether params.minArea currently holds a MEASURED value rather than a user-chosen one - it
// must fall with the calibration it came from, or teardown leaves a half-calibrated set.
let minAreaCalibrated = false;
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
    minArea: STAR_DETECT_DEFAULTS.minArea,
    // Classification
    minObservations: STAR_SOLVE_DEFAULTS.minObservations,
    driftSignificance: STAR_SOLVE_DEFAULTS.driftSignificance,
    driftMinSigmas: STAR_SOLVE_DEFAULTS.driftMinSigmas,
    // Display
    showStars: true,
    showMoving: true,
    showClusters: true,
    showRejected: false,
    showStarNames: true,
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
 * The decoded image for a frame, waiting until the decoder has genuinely produced it.
 *
 * getImage() alone returns the nearest ALREADY-DECODED frame when the requested one is not ready,
 * so a not-yet-decoded frame silently masquerades as a duplicate of its predecessor - which the
 * matcher would read as the camera having stopped. Driving par.frame as well keeps the render loop
 * and this pass asking for the same frame, instead of the decoder thrashing between two.
 */
async function frameImage(view, globalFrame, ctx) {
    const vd = view.videoData;
    par.frame = globalFrame;
    // The frame mapping comes from the SNAPSHOT, not from live state. A view locked to the In
    // point maps the global frame to a source frame by subtracting Sit.aFrame, and reading that
    // live means dragging the In marker mid-run silently re-bases the mapping part-way through -
    // the first half of the clip analysed at one offset and the second half at another.
    const f = ctx.lockToInFrame
        ? Math.max(0, globalFrame - ctx.aFrame)
        : globalFrame;
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

/** Read one frame's RGBA pixels, or null. Shared by the analysis pass and the calibration. */
async function framePixels(view, globalFrame, ctx) {
    const img = await frameImage(view, globalFrame, ctx);
    if (!img || !img.width) return null;
    const canvas = document.createElement("canvas");
    canvas.width = img.width;
    canvas.height = img.height;
    const c2d = canvas.getContext("2d", {willReadFrequently: true});
    c2d.drawImage(img, 0, 0);
    return {data: c2d.getImageData(0, 0, img.width, img.height).data, W: img.width, H: img.height};
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
 * not read as "stop"). The chained Measure/Analyze/Identify/Sync button gates on this; a false
 * that went unchecked would let a click's analysis and camera sync land on a video the user
 * swapped in AFTER clicking.
 */
export async function detectStarSize() {
    const view = videoView();
    if (!view || !view.videoData || running) return false;
    const generation = Globals.loadGeneration;
    const videoData = view.videoData;
    const ctx = {
        lockToInFrame: !!view.lockToInFrame,
        aFrame: Sit.aFrame ?? 0,
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
        params.minArea = cal.minArea;
        minAreaCalibrated = true;
        if (minAreaController) minAreaController.updateDisplay();
        params.status = `${cal.count} blobs, median ${cal.medianArea} px, r ~${cal.rPsf.toFixed(1)} px`
            + ` -> min area ${cal.minArea}, aperture ${cal.apertureRadius}`;
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
    const refToSky = r?.identify?.solved?.refToSky;
    if (!refToSky || !r.videoW) return null;
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
    return {centre: refToSky(rx0, ry0), above: refToSky(rx1, ry1)};
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
    apply(f, objectNode) {
        const pose = starTrackPose(f);
        if (!pose) return;
        const camera = objectNode.camera;
        const date = GlobalDateTimeNode.frameToDate(f);
        const D2R = Math.PI / 180;
        const fwd = getCelestialDirectionFromRaDec(
            pose.centre.raDeg * D2R, pose.centre.decDeg * D2R, date);
        const aboveDir = getCelestialDirectionFromRaDec(
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

/**
 * Register the star-field camera in the Camera menu's Heading (and FOV) source dropdowns and
 * switch to it. The user can switch back to Manual - or anything else - in the Camera menu;
 * the option stays available until the analysis is cleared.
 */
export function syncCameraToStarTrack() {
    if (!result?.identify?.solved?.ok) {
        params.status = "run Analyze and Identify Stars first";
        return;
    }
    const lookCamera = NodeMan.get("lookCamera", false);
    const headingSwitch = NodeMan.get("CameraLOSController", false);
    if (!lookCamera || !headingSwitch) {
        params.status = "no look camera to sync in this sitch";
        return;
    }

    let controller = NodeMan.get("starTrackCameraController", false);
    if (!controller) {
        controller = new CNodeControllerStarTrack({id: "starTrackCameraController"});
        lookCamera.addControllerNode(controller);
        // Tracking Wobble is attached at setup time; an absolute pose applied BEFORE it would
        // be wobbled, applied after it would wipe the wobble - keep wobble last.
        lookCamera.moveControllerToEnd?.("trackingWobbleController");
    }
    headingSwitch.replaceOption("Star Track", controller);
    headingSwitch.selectOption("Star Track");

    // The solve knows the zoom too: a constant vertical FOV from the fitted plate scale, so
    // the rendered sky matches the video's framing, selectable alongside the heading.
    const fovSwitch = NodeMan.get("fovSwitch", false);
    if (fovSwitch && result.videoH) {
        const vfovDeg = starTrackVfovDeg(result.identify.solved, result.videoH);
        let fovNode = NodeMan.get("starTrackFOV", false);
        if (fovNode) {
            fovNode.array = new Array(Sit.frames).fill(vfovDeg);
        } else {
            fovNode = new CNodeArray({id: "starTrackFOV", array: new Array(Sit.frames).fill(vfovDeg)});
        }
        fovSwitch.replaceOption("Star Track", fovNode);
        fovSwitch.selectOption("Star Track");
    }

    params.status = "camera synced to the star field";
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
export async function identifyStars() {
    if (!result) {
        params.status = "run Analyze first";
        return;
    }
    const myResult = result;
    const generation = myResult.generation;
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
        const stars = myResult.solved.classified
            .filter((c) => c.klass === "star" && c.position && Number.isFinite(c.magnitude)
                && c.n >= minIdentifyObs
                && !myResult.disabledStars?.has(c.index))
            .map((c) => ({x: c.position[0], y: c.position[1], mag: c.magnitude, index: c.index}));

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
        const fovWdeg = scalePrior
            ? scalePrior * Math.max(myResult.videoW, myResult.videoH) * 180 / Math.PI : 0;
        const tierOrder = STAR_IDENTIFY_DEFAULTS.tiers.map((_, i) => i);
        if (fovWdeg > 35) tierOrder.reverse();

        let solved = null;
        for (const tier of tierOrder) {
            if (!quadIndexes[tier]) {
                params.status = `building star geometry index (tier ${tier + 1})`;
                await yieldToBrowser();
                quadIndexes[tier] = buildQuadIndex(catalog, STAR_IDENTIFY_DEFAULTS.tiers[tier]);
                if (!fresh()) return;
            }
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
            let bx0 = 0, by0 = 0, bx1 = myResult.videoW || 0, by1 = myResult.videoH || 0;
            for (const s of stars) {
                if (s.x < bx0) bx0 = s.x;
                if (s.x > bx1) bx1 = s.x;
                if (s.y < by0) by0 = s.y;
                if (s.y > by1) by1 = s.y;
            }
            const boundsPad = 12;
            solved = solveField(stars, catalog, [quadIndexes[tier]], {
                ...(myResult.videoW ? {
                    center: [(bx0 + bx1) / 2, (by0 + by1) / 2],
                    width: Math.max(bx1 - bx0, by1 - by0),
                    bounds: [bx0 - boundsPad, by0 - boundsPad, bx1 + boundsPad, by1 + boundsPad],
                } : {}),
                ...(scalePrior ? {scalePrior} : {}),
            });
            if (!fresh()) return;
            if (solved.ok) break;
        }
        if (!solved || !solved.ok) {
            params.status = `identify failed: ${solved ? solved.reason : "no result"}`;
            return;
        }

        // Join the names on, keyed by the classified-track index the overlay draws from.
        const identified = new Map();
        for (const m of solved.matches) {
            const nm = names.get(m.hip);
            const label = nm?.name
                || (nm?.greek ? `${nm.greek} ${nm.constellation}` : `HIP ${m.hip}`);
            identified.set(stars[m.image].index, {
                label, hip: m.hip, mag: m.mag, raDeg: m.raDeg, decDeg: m.decDeg, dPx: m.dPx,
                // A PROPER name (Altair, Deneb) - drawn more prominently than the Bayer and
                // HIP-number fallbacks.
                named: !!nm?.name,
            });
        }
        myResult.identify = {solved, identified};

        // If the camera is already synced, a re-identification (say, after toggling stars off)
        // refines the plate scale under it. The heading controller reads the new refToSky live
        // at apply time, so the cached Star Track FOV must follow - otherwise heading and zoom
        // would come from two different solves.
        const fovNode = NodeMan.get("starTrackFOV", false);
        if (fovNode && myResult.videoH) {
            fovNode.array = new Array(Sit.frames).fill(starTrackVfovDeg(solved, myResult.videoH));
            setRenderOne();
        }
        const raH = solved.centerRaDeg / 15;
        params.status = `identified ${solved.matches.length}/${stars.length} stars - `
            + `field ${solved.fovDeg.toFixed(1)} deg at RA ${raH.toFixed(2)}h `
            + `Dec ${solved.centerDecDeg.toFixed(1)} deg, rms ${solved.rmsPx.toFixed(1)} px`;
        setRenderOne();
    } catch (e) {
        // Only while this run still owns the state - a failure surfacing after a sitch change
        // must not write over the new sitch's status.
        if (fresh()) params.status = `identify failed: ${e?.message ?? e}`;
    }
}

/**
 * Detect, solve, and classify over the In/Out (A-B) window.
 *
 * The window comes from abFrameRange, the same authority every other Sitrec analysis uses, so
 * moving the In/Out markers changes what this analyses in the way the user expects.
 */
export async function runStarTracker() {
    const view = videoView();
    if (!view || !view.videoData || running) return null;
    running = true;
    aborted = false;

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
        stale: () => aborted
            || Globals.loadGeneration !== generation
            || videoView() !== view
            || view.videoData !== videoData,
    };

    const {frame0, frame1} = abFrameRange(Sit.frames, 1);
    const total = frame1 - frame0 + 1;
    const savedFrame = par.frame;

    initProgress({
        title: "Star Tracker",
        filename: `Analyzing frames ${frame0}-${frame1}`,
        showAbort: true,
        onAbort: () => { aborted = true; },
    });

    // A still image on a video timeline (CVideoImageData) has ONE real frame however many the
    // timeline claims - detecting it hundreds of times over would be minutes of work for one
    // answer, and with no motion there is nothing to solve or classify: every detected point
    // is presumed a star, which is all a single exposure of the sky can honestly claim.
    const still = videoData instanceof CVideoImageData;

    try {
        const perFrame = [];
        let videoW = 0, videoH = 0;
        const rejectCounts = {};
        const rejectSamples = [];
        const lastFrame = still ? frame0 : frame1;
        for (let f = frame0; f <= lastFrame; f++) {
            if (ctx.stale()) {
                params.status = aborted ? "aborted" : "cancelled (video changed)";
                return null;
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

            // The "too big to be a star" bound scales with SENSOR AREA: the default was
            // measured on 720p-class footage, and on a 12-megapixel astrophoto the saturated
            // disk of a first-magnitude star legitimately covers tens of thousands of pixels -
            // a fixed bound silently deletes exactly the brightest stars in the image.
            const dynMaxArea = Math.round(STAR_DETECT_DEFAULTS.maxArea
                * Math.max(1, (px.W * px.H) / (1276 * 720)));
            const {sources} = detectSources(px.data, px.W, px.H, {
                threshSigma: ctx.threshSigma,
                minArea: ctx.minArea,
                maxArea: dynMaxArea,
                ...ctx.calDetect,
            });
            // The WHOLE detector record is kept, not a trimmed copy. Stage 3's photometry reads
            // apertureFlux/apertureComplete/apertureContaminated off it, and stripping the object
            // down to positions silently demotes every magnitude to the biased isophotal fallback.
            // Rejection runs with the SAME settings detection did, or the two disagree about
            // minArea and quietly re-reject blobs the user's setting admitted. What gets
            // rejected, and why, is tallied onto the result - "why is that star not circled"
            // should be answerable by looking.
            const kept = [];
            for (const s of sources) {
                const why = rejectReason(s, {minArea: ctx.minArea, maxArea: dynMaxArea});
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
            perFrame.push(kept);
        }

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
        result = {frame0, frame1, generation, videoData, perFrame, chain, solved, clusters,
            videoW, videoH, still, rejectCounts, rejectSamples};
        // Published for inspection and for other tools, the way camera motion publishes its own
        // per-video data on Globals.
        Globals.starTrackerResult = result;
        const counts = {};
        for (const c of solved.classified) counts[c.klass] = (counts[c.klass] || 0) + 1;
        params.status = still
            ? `${counts.star || 0} stars (still image)`
            : `${counts.star || 0} stars, ${counts.moving || 0} moving`
                + (clusters.length ? `, ${clusters.length} light cluster${clusters.length > 1 ? "s" : ""}` : "")
                + `, sigma ${solved.classified[0] ? solved.classified[0].sigma.toFixed(2) : "?"} px`;
        ensureOverlay();
        return result;
    } finally {
        running = false;
        hideProgress();
        if (Globals.loadGeneration === generation) par.frame = savedFrame;
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
    const disableAll = indices.some((ix) => !result.disabledStars.has(ix));
    for (const ix of indices) {
        if (disableAll) result.disabledStars.add(ix);
        else result.disabledStars.delete(ix);
    }
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

    // Clicking inside a star circle toggles that star. The overlay itself stays
    // pointer-transparent so the view's own drag/zoom handling is untouched; instead the DIV is
    // listened to in the capture phase, and a toggle fires only for a stationary click (a press
    // that moved is a drag, whatever it landed on). Marked on the div because the div IS the
    // per-sitch object - a new sitch builds a new one, which then needs its own hook.
    if (!view.div._starTrackClickHooked) {
        view.div._starTrackClickHooked = true;
        let downAt = null;
        view.div.addEventListener("pointerdown", (e) => {
            downAt = [e.clientX, e.clientY];
        }, true);
        view.div.addEventListener("pointerup", (e) => {
            if (!downAt || !result || !overlay) return;
            const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
            downAt = null;
            if (moved > 4) return;
            const rect = overlay.getBoundingClientRect();
            toggleStarsEnabled(
                starHitsAt(e.clientX - rect.left, e.clientY - rect.top).map((h) => h.index));
        }, true);
    }

    // Redraw after the view has painted the frame, so the circles land on the frame they describe.
    if (hookedView !== view && typeof view.renderCanvas === "function") {
        hookedView = view;
        const original = view.renderCanvas.bind(view);
        view.renderCanvas = (frame) => {
            original(frame);
            if (result) drawStarTrackerOverlay();
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
};

/**
 * Draw the classification over the video for the current frame.
 *
 * Circles are placed from the SOLVED star map rather than from that frame's detections, so they
 * stay put through a frame where a star was missed - which is the whole point of having solved the
 * camera motion. Radius comes from the measured magnitude.
 */
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

    for (const c of result.solved.classified) {
        if (!c.position) continue;
        if (c.klass === "short") continue;
        if (c.klass === "star" && !params.showStars) continue;
        if (c.klass === "moving" && !params.showMoving) continue;
        if ((c.klass === "incoherent" || c.klass === "cameraFixed") && !params.showRejected) continue;

        let rx = c.position[0], ry = c.position[1];
        if (c.klass === "moving") {
            // Only while the track is actually following the object: the nearest-observation
            // mapping below would happily carry its position to every OTHER frame too, pinning
            // a red circle to the sky before the object appears and after it has gone.
            if (i < c.first || i > c.last) continue;
            // A mover has no fixed map position, so show it where it actually was in the nearest
            // frame it was seen, brought into this frame through the solved transform.
            const t = result.solved.tracks[c.index];
            const o = t.obs.reduce((a, b) => (Math.abs(b.f - i) < Math.abs(a.f - i) ? b : a));
            rx = o.rx; ry = o.ry;
        }
        const [vx, vy] = applyTransform(T, rx, ry);
        // Display-space mapping, not videoToCanvasCoordsOriginal: that one expects ORIGINAL
        // source coordinates, and on a 4K clip decoded at a capped resolution it compresses
        // every circle toward the top-left, parting them from their stars.
        const [px, py] = toCanvas(vx, vy);
        if (px < -40 || py < -40 || px > overlay.width + 40 || py > overlay.height + 40) continue;

        const t01 = Number.isFinite(c.magnitude) && magMax > magMin
            ? (magMax - c.magnitude) / (magMax - magMin) : 0.5;
        const radius = 6 + t01 * 18;

        // Stars are clickable: register the circle as drawn, and dim a toggled-off star to 30% -
        // still visible enough to click back on, clearly out of the working set. Movers draw at
        // half strength so the circle and its label mark the object without painting over it.
        const disabled = c.klass === "star" && result.disabledStars?.has(c.index);
        if (c.klass === "star") overlayStarHits.push({x: px, y: py, r: radius, index: c.index});
        const alpha = disabled ? 0.3 : c.klass === "moving" ? 0.5 : 1;
        if (alpha !== 1) overlayCtx.globalAlpha = alpha;

        overlayCtx.beginPath();
        overlayCtx.arc(px, py, radius, 0, Math.PI * 2);
        overlayCtx.strokeStyle = COLORS[c.klass] || "#888";
        overlayCtx.lineWidth = c.klass === "moving" ? 3 : 1.8;
        overlayCtx.setLineDash(c.klass === "incoherent" ? [4, 4] : []);
        overlayCtx.stroke();

        if (c.klass === "moving") {
            overlayCtx.setLineDash([]);
            overlayCtx.fillStyle = COLORS.moving;
            overlayCtx.font = "bold 13px sans-serif";
            overlayCtx.fillText(`moves ${c.totalDrift.toFixed(0)} px vs stars`, px + radius + 6, py + 4);
        }

        // Identified stars carry their catalog names. A star with a PROPER name reads a
        // touch larger and in white; Bayer and HIP-number fallbacks stay quiet.
        if (c.klass === "star" && params.showStarNames && result.identify) {
            const id = result.identify.identified.get(c.index);
            if (id) {
                overlayCtx.setLineDash([]);
                overlayCtx.fillStyle = id.named ? "#fff" : "#9fdcb0";
                overlayCtx.font = id.named ? "12px sans-serif" : "11px sans-serif";
                overlayCtx.fillText(id.label, px + radius + 4, py + 4);
            }
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
    params.status = "not run";
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
    if (minAreaCalibrated) {
        params.minArea = STAR_DETECT_DEFAULTS.minArea;
        minAreaCalibrated = false;
    }
    minAreaController = null;
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
        .name("Measure/Analyze/Identify/Sync");
    folder.add(params, "status").name("Status").listen().disable();

    folder.add(params, "showStars").name("Show stars").onChange(setRenderOne);
    folder.add(params, "showMoving").name("Show moving").onChange(setRenderOne);
    folder.add(params, "showClusters").name("Show light clusters").onChange(setRenderOne);
    folder.add(params, "showStarNames").name("Show star names").onChange(setRenderOne);
    folder.add(params, "showRejected").name("Show rejected").onChange(setRenderOne);
    folder.add(params, "chartTracks").name("Chart: object tracks");

    const tweaks = folder.addFolder("Star Tracker Tweaks").close();

    tweaks.add(params, "threshSigma", 3, 10, 0.5).name("Detect threshold (sigma)");
    // A hand-edited value is a user preference, not a measurement - it must survive sitch
    // teardown, where a calibrated one falls with its calibration. The edit also invalidates
    // any calibration still awaiting its frame, or that request would land afterwards,
    // overwrite the user's choice, and mark it calibrated.
    minAreaController = tweaks.add(params, "minArea", 2, 40, 1).name("Min blob area (px)")
        .onFinishChange(() => {
            minAreaCalibrated = false;
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
    tweaks.add({cal: () => { detectStarSize(); }}, "cal").name("Detect Star Size (current frame)");
    tweaks.add(params, "minObservations", 3, 40, 1).name("Min detections per track");
    tweaks.add(params, "driftSignificance", 2, 20, 0.5).name("Moving: significance");
    tweaks.add(params, "driftMinSigmas", 2, 40, 1).name("Moving: min drift (sigma)");

    tweaks.add({run: async () => { await runStarTracker(); setRenderOne(); }}, "run")
        .name("Analyze In/Out range");
    tweaks.add({identify: () => { identifyStars(); }}, "identify")
        .name("Identify Stars (catalog)");
    tweaks.add({sync: () => { syncCameraToStarTrack(); }}, "sync")
        .name("Sync Camera to Star Field");
    tweaks.add({chart: () => { makeStarChart(); }}, "chart").name("Make Star Chart (PNG)");

    folder.add({clear: () => { resetStarTracker(); setRenderOne(); }}, "clear").name("Clear");
}
