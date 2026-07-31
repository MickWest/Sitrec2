// Star Tracker: the app-facing layer over the pure Star Track pipeline.
//
// Everything the analysis actually does lives in StarDetect / StarMatch / StarSolve, which are
// pure and testable. This module owns only the parts that need the running app: reading decoded
// video frames, the menu, and the overlay drawn on the video view.
//
// The menu lives under Video, alongside the other motion-analysis tools.

import {Globals, guiMenus, NodeMan, Sit, setRenderOne} from "../Globals";
import {par} from "../par";
import {abFrameRange} from "../TraverseAnalysisData";
import {hideProgress, initProgress, updateProgress} from "../CProgressIndicator";

import {STAR_DETECT_DEFAULTS, calibrateDetection, detectSources, rejectReason} from "./StarDetect";
import {applyTransform, invertTransform, solveFrameChain} from "./StarMatch";
import {STAR_SOLVE_DEFAULTS, solveStarField} from "./StarSolve";
import {STAR_CLUSTER_DEFAULTS, groupMovingClusters} from "./StarCluster";

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
    status: "not run",
};

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
 */
export async function detectStarSize() {
    const view = videoView();
    if (!view || !view.videoData || running) return;
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
        if (ctx.stale() || request !== calibrationRequest) return;
        if (!px) { params.status = "no decoded frame to measure"; return; }

        const cal = calibrateDetection(px.data, px.W, px.H, {threshSigma: params.threshSigma});
        if (!cal.ok) {
            // Keep whatever calibration exists. A failed measurement is not evidence the
            // previous one was wrong - and clearing it while params.minArea kept its measured
            // value would leave a half-calibrated, mismatched parameter set.
            params.status = `calibration failed: only ${cal.count} usable blobs on this frame`
                + (calibration ? "; keeping previous calibration" : "");
            return;
        }
        calibration = cal;
        params.minArea = cal.minArea;
        minAreaCalibrated = true;
        if (minAreaController) minAreaController.updateDisplay();
        params.status = `${cal.count} blobs, median ${cal.medianArea} px, r ~${cal.rPsf.toFixed(1)} px`
            + ` -> min area ${cal.minArea}, aperture ${cal.apertureRadius}`;
    } catch (e) {
        // The button fires this without awaiting it, so a throw anywhere above would otherwise
        // become an unhandled rejection with the status stuck at "measuring". Report it - but
        // only if this request still owns the status.
        if (request === calibrationRequest && !ctx.stale()) {
            params.status = `calibration failed: ${e?.message ?? e}`;
        }
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

    const MARGIN = 50;
    const xs = stars.map((c) => c.position[0]);
    const ys = stars.map((c) => c.position[1]);
    const x0 = Math.floor(Math.min(...xs)) - MARGIN;
    const y0 = Math.floor(Math.min(...ys)) - MARGIN;
    const fullW = Math.ceil(Math.max(...xs)) + MARGIN - x0;
    const fullH = Math.ceil(Math.max(...ys)) + MARGIN - y0;
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

    const mags = stars.map((c) => c.magnitude);
    const magMin = Math.min(...mags), magMax = Math.max(...mags);
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

    try {
        const perFrame = [];
        for (let f = frame0; f <= frame1; f++) {
            if (ctx.stale()) {
                params.status = aborted ? "aborted" : "cancelled (video changed)";
                return null;
            }
            const done = f - frame0 + 1;
            params.status = `detecting ${done}/${total}`;
            updateProgress({percent: (done / total) * 90, status: `Detecting sources: ${done}/${total}`});

            await yieldToBrowser();
            const px = await framePixels(view, f, ctx);
            if (!px) { perFrame.push([]); continue; }

            const {sources} = detectSources(px.data, px.W, px.H, {
                threshSigma: ctx.threshSigma,
                minArea: ctx.minArea,
                ...ctx.calDetect,
            });
            // The WHOLE detector record is kept, not a trimmed copy. Stage 3's photometry reads
            // apertureFlux/apertureComplete/apertureContaminated off it, and stripping the object
            // down to positions silently demotes every magnitude to the biased isophotal fallback.
            // Rejection runs with the SAME settings detection did, or the two disagree about
            // minArea and quietly re-reject blobs the user's setting admitted.
            perFrame.push(sources.filter((s) => !rejectReason(s, {minArea: ctx.minArea})));
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
            minObservations: ctx.minObservations,
            driftSignificance: ctx.driftSignificance,
            driftMinSigmas: ctx.driftMinSigmas,
            ...ctx.calSolve,
        });
        if (ctx.stale()) {
            params.status = aborted ? "aborted" : "cancelled (video changed)";
            return null;
        }

        // Stage 4: the lights that move TOGETHER - an aircraft's flashing cluster - grouped into
        // objects that no individual track is good enough to establish.
        updateProgress({percent: 99, status: "Grouping moving clusters"});
        await yieldToBrowser();
        const sigma = solved.classified.find((c) => c.sigma)?.sigma ?? 1;
        const clusters = groupMovingClusters(solved.tracks, solved.classified, solved.transforms,
            sigma, {...ctx.calSolve, ...ctx.calCluster});

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

        result = {frame0, frame1, generation, videoData, perFrame, chain, solved, clusters};
        // Published for inspection and for other tools, the way camera motion publishes its own
        // per-video data on Globals.
        Globals.starTrackerResult = result;
        const counts = {};
        for (const c of solved.classified) counts[c.klass] = (counts[c.klass] || 0) + 1;
        params.status = `${counts.star || 0} stars, ${counts.moving || 0} moving`
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

    const i = Math.round(par.frame) - result.frame0;
    const T = result.solved.transforms[i];
    if (!T) return;

    const mags = result.solved.classified
        .map((c) => c.magnitude).filter(Number.isFinite);
    const magMin = mags.length ? Math.min(...mags) : -11;
    const magMax = mags.length ? Math.max(...mags) : -7;

    for (const c of result.solved.classified) {
        if (!c.position) continue;
        if (c.klass === "short") continue;
        if (c.klass === "star" && !params.showStars) continue;
        if (c.klass === "moving" && !params.showMoving) continue;
        if ((c.klass === "incoherent" || c.klass === "cameraFixed") && !params.showRejected) continue;

        let rx = c.position[0], ry = c.position[1];
        if (c.klass === "moving") {
            // A mover has no fixed map position, so show it where it actually was in the nearest
            // frame it was seen, brought into this frame through the solved transform.
            const t = result.solved.tracks[c.index];
            const o = t.obs.reduce((a, b) => (Math.abs(b.f - i) < Math.abs(a.f - i) ? b : a));
            rx = o.rx; ry = o.ry;
        }
        const [vx, vy] = applyTransform(T, rx, ry);
        const [px, py] = view.videoToCanvasCoordsOriginal(vx, vy);
        if (px < -40 || py < -40 || px > overlay.width + 40 || py > overlay.height + 40) continue;

        const t01 = Number.isFinite(c.magnitude) && magMax > magMin
            ? (magMax - c.magnitude) / (magMax - magMin) : 0.5;
        const radius = 6 + t01 * 18;

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
    }

    // Light clusters - several lights moving together, no one of them trackable on its own.
    // Drawn from the ensemble's motion model, clamped to its lifetime so the ring rides the
    // object between flashes rather than extrapolating off into the dark.
    if (params.showClusters && result.clusters) {
        for (const cl of result.clusters) {
            if (i < cl.first - 3 || i > cl.last + 3) continue;
            const [rx, ry] = cl.at(Math.min(Math.max(i, cl.first), cl.last));
            const [vx, vy] = applyTransform(T, rx, ry);
            const [px, py] = view.videoToCanvasCoordsOriginal(vx, vy);
            if (px < -80 || py < -80 || px > overlay.width + 80 || py > overlay.height + 80) continue;
            // The ring's radius is the formation extent, mapped through the same video-to-canvas
            // scaling as the position so it hugs the same pixels at any window size.
            const [ex, ey] = view.videoToCanvasCoordsOriginal(vx + cl.extent + 10, vy);
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
    result = null;
    Globals.starTrackerResult = undefined;
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

    folder.add(params, "status").name("Status").listen().disable();

    folder.add(params, "threshSigma", 3, 10, 0.5).name("Detect threshold (sigma)");
    // A hand-edited value is a user preference, not a measurement - it must survive sitch
    // teardown, where a calibrated one falls with its calibration. The edit also invalidates
    // any calibration still awaiting its frame, or that request would land afterwards,
    // overwrite the user's choice, and mark it calibrated.
    minAreaController = folder.add(params, "minArea", 2, 40, 1).name("Min blob area (px)")
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
    folder.add({cal: () => { detectStarSize(); }}, "cal").name("Detect Star Size (current frame)");
    folder.add(params, "minObservations", 3, 40, 1).name("Min detections per track");
    folder.add(params, "driftSignificance", 2, 20, 0.5).name("Moving: significance");
    folder.add(params, "driftMinSigmas", 2, 40, 1).name("Moving: min drift (sigma)");

    folder.add({run: async () => { await runStarTracker(); setRenderOne(); }}, "run")
        .name("Analyze In/Out range");
    folder.add({chart: () => { makeStarChart(); }}, "chart").name("Make Star Chart (PNG)");

    folder.add(params, "showStars").name("Show stars").onChange(setRenderOne);
    folder.add(params, "showMoving").name("Show moving").onChange(setRenderOne);
    folder.add(params, "showClusters").name("Show light clusters").onChange(setRenderOne);
    folder.add(params, "showRejected").name("Show rejected").onChange(setRenderOne);

    folder.add({clear: () => { resetStarTracker(); setRenderOne(); }}, "clear").name("Clear");
}
