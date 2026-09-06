import {GlobalDateTimeNode, Globals, guiMenus, NodeMan, setRenderOne, Sit, unregisterFrameBlocker} from "./Globals";
import {par} from "./par";
import {getCV, loadOpenCV} from "./openCVLoader";
import {getJsfeat, loadJsfeat} from "./jsfeatLoader";
import {interpolatePosition} from "./CVideoData";
import {EventManager} from "./CEventManager";
import {KeyMan} from "./KeyBoardHandler";
import {createVideoExporter, DefaultVideoFormat, getBestFormatForResolution, getVideoExtension} from "./VideoExporter";
import {drawVideoWatermark, ExportProgressWidget, getExportPrefix} from "./utils";
import {showConfirm, showError} from "./showError";
import {drawAttributionOnCanvas} from "./AttributionOverlay";
import {isLocal} from "./configUtils";
import {t} from "./i18n";
import {Color} from "three";
import {MotionBackgroundTracker} from "./MotionBackgroundTracker";
import {MotionReacquisition} from './MotionReacquisition';
import {MotionTrackingRegime} from './MotionTrackingRegime';
import {addVideoAnalysisResolutionMenu, beginVideoAnalysis} from './VideoAnalysisResolution';
import {normalizeTrackSmoothing, smoothPointTrack, TrackPositionMap} from './PointTrackSmoothing';

let cv = null;

function yieldTrackingTask() {
    if (typeof MessageChannel === 'undefined') return new Promise(resolve => setTimeout(resolve, 0));
    // Like the fitting tools, yield through a message task. Background tabs
    // can throttle setTimeout to one callback a minute, effectively stalling
    // a long analysis as soon as the user switches to another clip.
    return new Promise(resolve => {
        const channel = new MessageChannel();
        channel.port1.onmessage = () => {
            channel.port1.close();
            channel.port2.close();
            resolve();
        };
        channel.port2.postMessage(0);
    });
}

// A user point resets the tracker's idea of where the object is: it becomes the
// newest anchor, any pending candidate is dropped and the miss count goes back
// to zero. Without that the tracker keeps aiming from a stale anchor and ignores
// the correction it was just handed.
function anchorsFromUserPoint(tracker, frame, x, y) {
    // A correction also invalidates the old velocity. Extrapolating the jump
    // from an erroneous auto point would immediately steer away from the click.
    tracker.motionAnchors = [{frame, x, y}];
    tracker.motionLastFrame = frame;
    tracker.motionCandidate = null;
    tracker.motionTrail = [];
    tracker.motionScores = [];
    tracker.motionMisses = 0;
    tracker.motionOffscreen = false;
    tracker.motionReacquisition?.reset();
    tracker.motionRegime?.reset();
}

// Settings the user can change from the menu BEFORE Point Track is enabled —
// that is, before the tracker object exists at all. Without somewhere to hold
// them the menu silently reverts: the setter has no tracker to write to and
// drops the value, then .listen() repaints the old one, with no error anywhere.
// These are applied to the tracker the moment it is created.
const pendingTrackingSettings = {
    trackingMethod: 'template',
    motionPolarity: 'both',
    motionGap: 3,
    motionSamples: 8,
    motionSlack: 0,
    motionThreshold: 6,
    smoothingFrames: 0,
};

function applyPendingTrackingSettings(tracker) {
    for (const [key, value] of Object.entries(pendingTrackingSettings)) tracker[key] = value;
}

// Auto Tracking - Automatic object tracking using OpenCV template matching or centroid tracking
// This is distinct from Manual Tracking (CNodeTrackingOverlay) which requires manual keyframe placement

// Separable Gaussian blur on a Float32Array luma plane. Used by peak tracking
// to suppress noise and emphasise features near the chosen size scale.
function gaussianBlur1D(luma, w, h, sigma) {
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const size = radius * 2 + 1;
    const kernel = new Float32Array(size);
    const denom = 2 * sigma * sigma;
    let sum = 0;
    for (let i = 0; i < size; i++) {
        const x = i - radius;
        kernel[i] = Math.exp(-(x * x) / denom);
        sum += kernel[i];
    }
    for (let i = 0; i < size; i++) kernel[i] /= sum;

    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let v = 0;
            for (let k = -radius; k <= radius; k++) {
                const xx = x + k < 0 ? 0 : x + k >= w ? w - 1 : x + k;
                v += luma[y * w + xx] * kernel[k + radius];
            }
            tmp[y * w + x] = v;
        }
    }
    const out = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let v = 0;
            for (let k = -radius; k <= radius; k++) {
                const yy = y + k < 0 ? 0 : y + k >= h ? h - 1 : y + k;
                v += tmp[yy * w + x] * kernel[k + radius];
            }
            out[y * w + x] = v;
        }
    }
    return out;
}

export class ObjectTracker {
    constructor(videoView) {
        this.videoView = videoView;
        this.enabled = false;
        this.tracking = false;
        this.overlayCreated = false;
        this.overlay = null;
        this.overlayCtx = null;

        this.trackX = 0;
        this.trackY = 0;
        // True once trackX/trackY hold a real position rather than the placeholder
        // above - set when a save is restored. createOverlay() seeds the cursor to
        // the middle of the video only while this is false.
        this.trackPositionSet = false;
        this.trackRadius = 30;

        this.trackedPositions = new Map();
        this.smoothingFrames = 0;
        this.manualKeyframes = new Set();

        this.isDragging = false;
        this.draggingKeyframe = null;
        this.lastMouseX = 0;
        this.lastMouseY = 0;

        this.tracker = null;
        this.trackerType = 'CSRT';

        // Hold-key loops: ' (advance & track at fps) and ; (rewind & delete keyframes)
        this.holdLoopActive = false;

        this.brightnessThreshold = 128;  // 0-255, used by centerOnBright/centerOnDark methods

        // Skip masked pixels when centring (see calculateWeightedCentroid). Default ON, which
        // changes nothing for anyone without a mask - and someone who has painted one has
        // already said those pixels are not to be used.
        this.useMask = true;

        // Used by centerOnColor: target color (Three.js Color) and the maximum
        // RGB Euclidean distance (0..441) a pixel may be from that color and
        // still contribute to the centroid. The weight is (distance - colorDistance),
        // so pixels closer to the target color dominate, exactly mirroring the
        // (brightness - threshold) weight used by Center on Bright.
        this.trackingColor = new Color(0xff0000);
        this.colorDistance = 80;

        // Feature size in image pixels — Gaussian sigma applied before peak
        // detection. Higher = smoother / larger features, smaller noise
        // suppressed. Range 2..20 in the GUI.
        this.featureSize = 4;
        this.featureSizePreview = false;

        // Search radius - how far from previous position to search for template match
        this.searchRadius = 50;  // pixels

        // Tracking method:
        //   'template'        — OpenCV template matching (default)
        //   'opticalflow'     — jsfeat Lucas-Kanade
        //   'centerOnBright'  — brightness-weighted centroid above threshold
        //   'centerOnDark'    — brightness-weighted centroid below threshold
        //   'centerOnColor'   — color-similarity-weighted centroid within colorDistance
        //   'highPeak'        — local-maximum peak (blob-shaped, motion-extrapolated)
        //   'lowPeak'         — local-minimum peak (dark blob)
        //   'motion'          — background-motion subtraction (see below)
        //   'sam2'            — server-side SAM2 segmentation
        this.trackingMethod = 'template';

        // Motion tracking: the only method that does not key on appearance. It
        // asks what is inconsistent with the BACKGROUND's own motion, so it can
        // follow a target across clutter of identical brightness and texture,
        // where template matching and the centroid methods have nothing to lock
        // onto. See MotionBackgroundTracker.js.
        this.motionTracker = null;
        // Frames between the background samples. Larger separates the target
        // from where it used to be; too large and the planar-background
        // assumption starts to break down.
        this.motionGap = 3;
        // How many earlier frames the background median is built from.
        this.motionSamples = 8;
        // Px of background displacement to forgive. 0 for a flat, nadir scene;
        // 2-3 for rugged terrain viewed obliquely, where real parallax means no
        // single homography can cancel the background exactly.
        this.motionSlack = 0;
        // Detection threshold, in units of the response's own robust noise.
        this.motionThreshold = 6;
        // Which way the target differs from its background.
        this.motionPolarity = 'both';
        // Consecutive frames with no trusted detection, and how many of those to
        // ride out before giving up and holding still.
        this.motionMisses = 0;
        this.motionMaxCoast = 15;
        this.motionRegime = new MotionTrackingRegime();
        // While lost, attempt a wide re-acquisition this often (frames).
        this.motionReacquireEvery = 5;
        // Largest believable frame-to-frame jump, in decoded-image pixels, for an
        // object that is otherwise stationary. Scaled up by how fast the object
        // has actually been moving, so a fast target is not held back.
        this.motionMinJump = 6;
        // A sighting waiting for a second one to confirm it.
        this.motionCandidate = null;
        // Scores of recent accepted detections, so the tracker can judge a new
        // sighting against what this particular clip has been yielding rather
        // than against a fixed number.
        this.motionScores = [];
        // Recent unconfirmed sightings, for the coherence test.
        this.motionTrail = [];
        // Largest believable change of velocity between sightings, px/frame^2.
        this.motionCoherence = 4;
        // Draw the motion field itself instead of the video — what the detector
        // is actually working from.
        this.showMotionField = false;
        this.motionFieldCache = null;
        this.motionLastFrame = null;
        this.motionOffscreen = false;
        this.motionReacquisition = new MotionReacquisition();
        // Frames where the object was actually measured, in decoded-image
        // coordinates. The gate is aimed from these and from nothing else.
        this.motionAnchors = [];
        // Rolling record of why each frame was accepted or rejected. Diagnosing
        // a lost lock from the resulting track alone is guesswork — the track
        // cannot tell you whether the detector saw nothing or the gate was
        // pointed somewhere else, and those need opposite fixes. Local builds
        // only, alongside the window._objectTracker hook.
        this.motionDebug = isLocal ? [] : null;

        // Maximum number of keyframes to display (0 = none, 100 = all)
        this.showMaxKeyframes = 20;

        // "Edit Head Only": restrict dragging to the head - the point at the
        // current frame, under the yellow cursor. With a dense track the older
        // keyframes crowd the cursor and win the click, so nudging the current
        // point silently moves a neighbour instead. Everything still DRAWS; the
        // parts that can no longer be grabbed just fade back (see renderOverlay).
        this.editHeadOnly = false;

        // Optical flow state (for absolute tracking from initial frame)
        this.initialGrayImage = null;
        this.initialPyramid = null;
        this.initialKeypoints = null;
        this.initialKeypointCoords = null;
        this.initialCenter = null;

        // Store initial template for absolute tracking (prevents drift)
        this.initialTemplate = null;
        this.initialTemplateFrame = null;

        this.guiFolder = null;
        this.savedPaused = true;
        this.savedFrame = undefined;

        // Track video dimensions to detect when video changes
        this.lastVideoWidth = 0;
        this.lastVideoHeight = 0;
        
        this.thresholdPreview = false;
    }
    
    createOverlay() {
        if (this.overlayCreated) return;
        this.overlayCreated = true;
        
        this.overlay = document.createElement('canvas');
        this.overlay.style.position = 'absolute';
        this.overlay.style.top = '0';
        this.overlay.style.left = '0';
        this.overlay.style.width = '100%';
        this.overlay.style.height = '100%';
        this.overlay.style.pointerEvents = 'none';
        this.overlay.style.zIndex = '100';
        this.videoView.div.appendChild(this.overlay);
        this.overlayCtx = this.overlay.getContext('2d');
        
        this.hookMouseHandler();
        
        // Seed the cursor only when nothing has placed it yet. A tracker restored
        // from a save already has its position, and the overlay may not be created
        // until well after the restore (a track loaded disabled creates it on the
        // user's first enable) - seeding then would discard the saved position.
        if (!this.trackPositionSet) {
            const {width, height} = this.getImageDimensions();
            this.trackX = width / 2;
            this.trackY = height / 2;
            this.trackPositionSet = true;
        }
    }
    
    hookMouseHandler() {
        const mouse = this.videoView.mouse;
        if (!mouse) return;
        
        const originalDrag = mouse.handlers.drag;
        
        mouse.handlers.down = (e) => {
            if (this.enabled) {
                const x = mouse.x;
                const y = mouse.y;
                const [vX, vY] = this.videoView.canvasToVideoCoordsOriginal(x, y);
                
                // Edit Head Only: skip the keyframe hit-test entirely, so an
                // old keyframe lying near the cursor cannot take the drag. What
                // is left is isWithinTrackPoint, which moves the head.
                const clickedKeyframe = this.editHeadOnly
                    ? null : this.findClickedKeyframe(vX, vY);
                if (clickedKeyframe !== null) {
                    this.isDragging = true;
                    this.draggingKeyframe = clickedKeyframe;
                    this.lastMouseX = vX;
                    this.lastMouseY = vY;
                } else if (this.isWithinTrackPoint(vX, vY)) {
                    this.isDragging = true;
                    this.draggingKeyframe = null;
                    this.lastMouseX = vX;
                    this.lastMouseY = vY;
                }
            }
        };
        
        mouse.handlers.drag = (e) => {
            if (this.enabled && this.isDragging) {
                const x = mouse.x;
                const y = mouse.y;
                const [vX, vY] = this.videoView.canvasToVideoCoordsOriginal(x, y);
                
                const dx = vX - this.lastMouseX;
                const dy = vY - this.lastMouseY;
                this.lastMouseX = vX;
                this.lastMouseY = vY;
                
                if (this.draggingKeyframe !== null) {
                    const pos = this.trackedPositions.get(this.draggingKeyframe);
                    if (pos) {
                        pos.x += dx;
                        pos.y += dy;
                        this.trackedPositions.set(this.draggingKeyframe, pos);
                    }
                } else {
                    this.trackX += dx;
                    this.trackY += dy;
                    const frame = Math.floor(par.frame);
                    this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
                    this.manualKeyframes.add(frame);
                }
                this.updateSliderStatus();
                
                setRenderOne(true);
                return;
            }
            if (originalDrag) originalDrag(e);
        };
        
        mouse.handlers.up = (e) => {
            if (this.isDragging) {
                this.isDragging = false;
                this.draggingKeyframe = null;
                if (this.tracking) {
                    this.initializeTracker();
                }
            }
        };
        
        EventManager.addEventListener("keydown", (data) => {
            if (!this.enabled) return;
            // Ignore OS auto-repeat — hold loops start once on first keydown
            // and run until KeyMan reports the key released.
            if (data.event?.repeat) return;
            const key = data.key.toLowerCase();
            if (key === 'backspace' || key === 'delete') {
                const x = mouse.x;
                const y = mouse.y;
                const [vX, vY] = this.videoView.canvasToVideoCoordsOriginal(x, y);
                const clickedKeyframe = this.findClickedKeyframe(vX, vY);
                if (clickedKeyframe !== null) {
                    this.trackedPositions.delete(clickedKeyframe);
                    this.manualKeyframes.delete(clickedKeyframe);
                    this.updateSliderStatus();
                    setRenderOne(true);
                }
            } else if ((key === "'" || key === ";")
                && !this.holdLoopActive && !this.tracking) {
                this.holdLoopActive = true;
                this.runHoldLoop(key === "'" ? 'forward' : 'backward').catch(error => {
                    console.error('Point tracking failed', error);
                    showError(`Point tracking failed: ${error.message}`);
                });
            }
        });
    }

    // Hold-key playback used to combine auto and manual tracking:
    //   '  : advance frame-by-frame at video fps, running the tracker on
    //        each new frame. Lets the user step into the track and verify
    //        each step before committing.
    //   ;  : step backward at video fps, deleting any tracked keyframe at
    //        each frame. Lets the user rewind through a bad auto-track
    //        section, then re-anchor manually.
    async runHoldLoop(direction) {
        const videoData = this.videoView?.videoData;
        if (!videoData) { this.holdLoopActive = false; return; }

        const fps = Sit.fps || 30;
        const targetInterval = 1000 / fps;
        const lastFrame = Sit.bFrame ?? (Sit.frames - 1);
        const firstFrame = Sit.aFrame ?? 0;
        const heldKey = direction === 'forward' ? "'" : ";";

        const savedPaused = par.paused;
        par.paused = true;

        // Forward mode runs the actual tracking algorithm. Re-init the
        // template/keypoints from the current position so a fresh hold press
        // (after the user has e.g. just placed a manual keyframe) starts
        // matching from there, not from a stale earlier feature.
        try {
            if (direction === 'forward') {
                // The keyboard path can be used before Start or Analyse Object
                // has loaded the selected method's library.
                if (this.trackingMethod === 'motion' || this.trackingMethod === 'template') {
                    await loadOpenCV();
                    cv = getCV();
                } else if (this.trackingMethod === 'opticalflow' && !getJsfeat()) {
                    await loadJsfeat();
                }
                if (!this.enabled || !KeyMan.isKeyHeld(heldKey)) return;
                this.analysisResolutionSession = beginVideoAnalysis(videoData, () => { this.tracking = false; });
                this.tracking = true;
                this.initializeTracker();
                Globals.justVideoAnalysis = true;
            }
            while (KeyMan.isKeyHeld(heldKey) && (direction !== 'forward' || this.tracking)) {
                const tickStart = performance.now();
                const cur = Math.floor(par.frame);

                if (direction === 'forward') {
                    const nf = cur + 1;
                    if (nf > lastFrame) break;
                    par.frame = nf;
                    videoData.getImage(nf);
                    const ready = await videoData.waitForFrame(nf, 5000);
                    if (!KeyMan.isKeyHeld(heldKey) || !this.tracking) break;
                    if (!ready) break;
                    // force=true so we re-run the algorithm even if the new
                    // frame already has a stale stored position.
                    this.trackFrame(nf, true);
                } else {
                    // Delete any keyframe at the current frame, then step back.
                    this.trackedPositions.delete(cur);
                    this.manualKeyframes.delete(cur);
                    const nf = cur - 1;
                    if (nf < firstFrame) break;
                    par.frame = nf;
                    videoData.getImage(nf);
                    await videoData.waitForFrame(nf, 5000);
                    // Snap the cursor to whatever interpolated position remains
                    // (or leave it where it was if the track is now empty).
                    const ip = this.getInterpolatedPosition(nf);
                    if (ip) { this.trackX = ip.x; this.trackY = ip.y; }
                }

                if (this.videoView?.renderCanvas) {
                    this.videoView.renderCanvas(par.frame);
                }
                this.updateSliderStatus();

                const elapsed = performance.now() - tickStart;
                const sleep = Math.max(0, targetInterval - elapsed);
                await new Promise(r => setTimeout(r, sleep));
            }
        } finally {
            if (direction === 'forward') {
                this.analysisResolutionSession?.end();
                this.analysisResolutionSession = null;
                this.tracking = false;
                Globals.justVideoAnalysis = false;
            }
            par.paused = savedPaused;
            this.holdLoopActive = false;
            setRenderOne(true);
        }
    }
    
    getImageDimensions() {
        // Returns the source video's *original* dimensions — the canonical
        // reference for tracker positions. This is stable across resolution
        // changes from the videoMaxSize quality preset, so positions saved at
        // one preset render correctly under any other.
        const videoData = this.videoView?.videoData;
        if (!videoData) return {width: 1920, height: 1080};
        return {
            width: videoData.originalVideoWidth || videoData.videoWidth || 1920,
            height: videoData.originalVideoHeight || videoData.videoHeight || 1080,
        };
    }

    // Scale a tracker-coord (original-video) point to actual decoded image
    // coords for pixel-level operations on a specific image.
    trackerToImage(p, image) {
        const vd = this.videoView?.videoData;
        const origW = vd?.originalVideoWidth;
        const origH = vd?.originalVideoHeight;
        if (!origW || !origH) return {x: p.x, y: p.y};
        const w = image?.width || image?.videoWidth || vd?.videoWidth || origW;
        const h = image?.height || image?.videoHeight || vd?.videoHeight || origH;
        return {x: p.x * w / origW, y: p.y * h / origH};
    }

    // Inverse of trackerToImage — for converting an algorithm result back to
    // tracker (original-video) coords before storing.
    imageToTracker(p, image) {
        const vd = this.videoView?.videoData;
        const origW = vd?.originalVideoWidth;
        const origH = vd?.originalVideoHeight;
        if (!origW || !origH) return {x: p.x, y: p.y};
        const w = image?.width || image?.videoWidth || vd?.videoWidth || origW;
        const h = image?.height || image?.videoHeight || vd?.videoHeight || origH;
        return {x: p.x * origW / w, y: p.y * origH / h};
    }
    
    showOverlay() {
        if (this.overlay) this.overlay.style.display = 'block';
    }
    
    hideOverlay() {
        if (this.overlay) {
            this.overlay.style.display = 'none';
            if (this.overlayCtx) {
                this.overlayCtx.clearRect(0, 0, this.overlay.width, this.overlay.height);
            }
        }
    }
    
    enable() {
        this.enabled = true;
        this.createOverlay();
        this.showOverlay();
        setRenderOne(true);
    }
    
    disable() {
        if (this.tracking) this.stopTracking();
        this.analysisResolutionSession?.end();
        this.analysisResolutionSession = null;
        this.motionFieldResolutionSession?.end();
        this.motionFieldResolutionSession = null;
        this.enabled = false;
        this.tracking = false;
        this.hideOverlay();
        this.clearSliderStatus();
        unregisterFrameBlocker('objectTracking');
    }
    
    startTracking() {
        if (!this.enabled || this.tracking || this.holdLoopActive) return;
        this.trackingRunId = (this.trackingRunId || 0) + 1;
        this.analysisResolutionSession = beginVideoAnalysis(this.videoView?.videoData, () => this.onTrackingComplete());
        this.tracking = true;
        this.initializeTracker();
        this.updateSliderStatus();

        this.savedPaused = par.paused;
        this.savedFrame = par.frame;
        Globals.justVideoAnalysis = true;
        par.paused = true;  // Pause the animation loop

        // Start fast tracking loop
        this.runFastTrackingLoop().catch(error => {
            console.error('Point tracking failed', error);
            showError(`Point tracking failed: ${error.message}`);
        });
    }
    
    async runFastTrackingLoop() {
        const runId = this.trackingRunId;
        try {
            await this.trackFrames(runId);
        } finally {
            // A stopped run may still be returning from a decode wait after
            // the user has already started another one.
            if (runId === this.trackingRunId) this.onTrackingComplete();
        }
    }

    async trackFrames(runId) {
        const startFrame = Math.floor(par.frame);
        const bFrame = Sit.bFrame ?? (Sit.frames - 1);
        const videoData = this.videoView?.videoData;

        if (!videoData) return;

        // Target 25 FPS for visual updates (40ms per render)
        const targetRenderInterval = 40; // ms
        let lastRenderTime = performance.now();

        const wrapperHasHolds = typeof videoData.isHeldFrame === "function";

        for (let frame = startFrame; frame <= bFrame; frame++) {
            if (!this.tracking || runId !== this.trackingRunId) break;

            // Set current frame
            par.frame = frame;

            // Skip held (synthesized duplicate) frames: identical pixels as
            // the prior canonical V, so template-matching would produce the
            // same answer at the same wall-clock budget. Carry the previous
            // tracked position forward so any consumer reading
            // trackedPositions.get(frame) sees a value, but skip the work.
            if (wrapperHasHolds && videoData.isHeldFrame(frame) && !this.isUserPoint(frame)) {
                const prev = this.trackedPositions.get(frame - 1);
                if (prev) this.trackedPositions.set(frame, {...prev});
                else if (this.trackingMethod === 'motion') this.trackedPositions.markUnmeasured(frame);
                continue;
            }

            // Wait for video frame to be loaded (with timeout)
            videoData.getImage(frame);
            const ready = await videoData.waitForFrame(frame, 5000);
            if (!this.tracking || runId !== this.trackingRunId) break;
            // getImage() may return a nearby frame for smooth playback. Never
            // turn that fallback into a measurement at the requested time.
            if (!ready) continue;

            // Track this frame
            this.trackFrame(frame);

            // Only render and yield if enough time has passed (target 25 FPS visual updates)
            const now = performance.now();
            const shouldRender = (now - lastRenderTime >= targetRenderInterval) || (frame === bFrame);

            if (shouldRender) {
                // Render the video viewport
                if (this.videoView && this.videoView.renderCanvas) {
                    this.videoView.renderCanvas(frame);
                }
                // Update slider status
                this.updateSliderStatus();

                lastRenderTime = now;

                // Only yield to browser when we render (keep UI responsive)
                await yieldTrackingTask();
            }
        }

    }

    stopTracking() {
        this.trackingRunId = (this.trackingRunId || 0) + 1;
        this.tracking = false;
        this.analysisResolutionSession?.end();
        this.analysisResolutionSession = null;
        if (this.tracker) {
            this.tracker = null;
        }
        par.paused = this.savedPaused;
        if (this.savedFrame !== undefined) {
            par.frame = this.savedFrame;
        }
        Globals.justVideoAnalysis = false;
        setRenderOne(true);
    }
    
    onTrackingComplete() {
        this.stopTracking();
        this.refreshSmoothedOutput();
        if (startMenuItem) startMenuItem.name(t("tracking.start.label"));
        setRenderOne(true);
    }
    
    initializeTracker() {
        const frame = Math.floor(par.frame);
        const given = this.trackedPositions.get(frame);
        if (given) {
            this.trackX = given.x;
            this.trackY = given.y;
        } else {
            this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
        }
        
        if (this.initialTemplate) {
            this.initialTemplate.delete();
        }
        this.initialTemplate = null;
        this.initialTemplateFrame = null;
        
        this.initialGrayImage = null;
        this.initialPyramid = null;
        this.initialKeypoints = null;
        this.initialKeypointCoords = null;
        this.initialCenter = null;

        // Cached homographies describe one forward walk through one clip; a
        // fresh run must not compose them into a different one.
        if (this.motionTracker) this.motionTracker.reset();
        this.motionMisses = 0;
        this.motionOffscreen = false;
        this.motionLastFrame = null;
        this.motionReacquisition.reset();
        this.motionAnchors = [];
        this.motionCandidate = null;
        this.motionScores = [];
        this.motionTrail = [];
    }
    
    isWithinTrackPoint(vX, vY) {
        const dx = vX - this.trackX;
        const dy = vY - this.trackY;
        return (dx * dx + dy * dy) <= (this.trackRadius * this.trackRadius);
    }

    findClickedKeyframe(vX, vY) {
        // 5 screen pixels converted to *original-video* coords (the space
        // tracker positions live in). sWidth is the displayed video width;
        // scale through originalVideoWidth so it matches stored positions.
        const view = this.videoView;
        view.getSourceAndDestCoords();
        const origW = view.originalVideoWidth || view.videoWidth || view.sWidth || 1;
        const clickRadius = 5 * origW / view.dWidth;
        for (const frame of this.manualKeyframes) {
            const pos = this.trackedPositions.get(frame);
            if (pos) {
                const dx = vX - pos.x;
                const dy = vY - pos.y;
                if (dx * dx + dy * dy <= clickRadius * clickRadius) {
                    return frame;
                }
            }
        }
        return null;
    }

    // Generic weighted-centroid pass. Returns {x, y} in image coordinates
    // (weighted by `weightFn(r, g, b)`) or null if no pixel contributed.
    // weightFn must return 0 for "ignore", positive for "include with weight".
    // Used by all three centroid methods (bright, dark, color) so the ROI
    // extraction, circular gate, and centroid math live in one place.
    calculateWeightedCentroid(image, centerX, centerY, radius, weightFn) {
        const imgWidth = image.width || image.videoWidth;
        const imgHeight = image.height || image.videoHeight;

        // Define ROI bounds (rectangle that contains the circle)
        const minX = Math.max(0, Math.floor(centerX - radius));
        const maxX = Math.min(imgWidth - 1, Math.ceil(centerX + radius));
        const minY = Math.max(0, Math.floor(centerY - radius));
        const maxY = Math.min(imgHeight - 1, Math.ceil(centerY + radius));

        const roiWidth = maxX - minX + 1;
        const roiHeight = maxY - minY + 1;

        // Extract ONLY the ROI pixels
        const canvas = document.createElement('canvas');
        canvas.width = imgWidth;
        canvas.height = imgHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, imgWidth, imgHeight);

        const imageData = ctx.getImageData(minX, minY, roiWidth, roiHeight);
        const data = imageData.data;

        let totalWeight = 0;
        let weightedX = 0;
        let weightedY = 0;
        let pixelCount = 0;

        const radiusSquared = radius * radius;

        // The video mask, resolved ONCE per pass rather than per pixel. Masked pixels are
        // dropped from the centroid entirely, which is the whole point: the centroid is a
        // weighted average, so a bright patch of masked ground inside the track radius does not
        // merely add noise, it DRAGS the tracked point towards itself and the tracker walks off
        // the object into the trees.
        //
        // Applied here because this one pass serves all three centroid rules - bright, dark and
        // colour - so they cannot disagree about what is off-limits.
        //
        // Coordinates are rescaled into the mask canvas rather than used directly: the mask is
        // in VIDEO pixels (invariant 2 in CNodeMaskOverlay) and this image need not be that
        // size, so indexing it directly would reject the wrong region on any capped decode.
        const mask = this.useMask ? NodeMan.get("videoMask", false) : null;
        const maskCanvas = mask?.maskImageData ? mask.maskCanvas : null;
        const maskScaleX = maskCanvas ? maskCanvas.width / imgWidth : 1;
        const maskScaleY = maskCanvas ? maskCanvas.height / imgHeight : 1;

        for (let roiY = 0; roiY < roiHeight; roiY++) {
            for (let roiX = 0; roiX < roiWidth; roiX++) {
                const imgX = minX + roiX;
                const imgY = minY + roiY;

                // Circular gate (the ROI rectangle is larger than the disk)
                const dx = imgX - centerX;
                const dy = imgY - centerY;
                if (dx * dx + dy * dy > radiusSquared) continue;

                if (maskCanvas && mask.isPointMasked(imgX * maskScaleX, imgY * maskScaleY)) continue;

                const index = (roiY * roiWidth + roiX) * 4;
                const w = weightFn(data[index], data[index + 1], data[index + 2]);
                if (w > 0) {
                    totalWeight += w;
                    weightedX += imgX * w;
                    weightedY += imgY * w;
                    pixelCount++;
                }
            }
        }

        if (totalWeight > 0 && pixelCount > 0) {
            return {
                x: weightedX / totalWeight,
                y: weightedY / totalWeight,
            };
        }
        return null;
    }

    // Centroid weight rules — each one returns 0 for "skip" or a positive
    // weight that biases the centroid toward the most-matching pixels.
    _brightWeight(r, g, b) {
        const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
        return brightness > this.brightnessThreshold ? brightness - this.brightnessThreshold : 0;
    }

    _darkWeight(r, g, b) {
        const brightness = 0.299 * r + 0.587 * g + 0.114 * b;
        return brightness < this.brightnessThreshold ? this.brightnessThreshold - brightness : 0;
    }

    _colorWeight(r, g, b) {
        const tr = this.trackingColor.r * 255;
        const tg = this.trackingColor.g * 255;
        const tb = this.trackingColor.b * 255;
        const dr = r - tr, dg = g - tg, db = b - tb;
        const dist = Math.sqrt(dr * dr + dg * dg + db * db);
        return dist < this.colorDistance ? this.colorDistance - dist : 0;
    }

    trackFrame(frame, force = false) {
        if (!this.tracking || !this.enabled) return;

        frame = Math.floor(frame);

        // User points outrank every algorithm, including forced re-tracking and
        // held frames. Handle them before the already-tracked fast path so they
        // actually reset the motion prediction in a normal Start Tracking run.
        const given = this.isUserPoint(frame) && this.trackedPositions.get(frame);
        if (given) {
            this.trackX = given.x;
            this.trackY = given.y;
            this.anchorMotionPoint(frame, given);
            return;
        }

        // Skip already-tracked frames in the full-speed loop. The ' hold-loop
        // passes force=true so the user can deliberately re-run tracking over
        // a stale section (e.g. a stuck auto-track that wrote the same dud
        // position across many frames).
        if (!force && this.trackedPositions.has(frame)) {
            const pos = this.trackedPositions.get(frame);
            this.trackX = pos.x;
            this.trackY = pos.y;
            // Stored auto points have no saved measurement confidence. Start a
            // new prediction at the end of this section instead of retaining a
            // velocity from before the skipped frames.
            // renderOverlay also calls this for the frame just measured. That
            // redraw must retain its anchors for the next tracking step.
            if (this.trackingMethod === 'motion' && this.motionLastFrame !== frame) this.motionLastFrame = null;
            return;
        }

        if (!force && this.trackingMethod === 'motion' && this.motionLastFrame === frame) return;

        // Seed selection:
        //   force=true (' hold-loop): use current cursor position so a freshly-
        //     placed manual keyframe drives the algorithm, not stale stored data.
        //   peak methods: use motion-extrapolated prediction from the last two
        //     tracked frames so a moving feature is followed even when the
        //     stored position at frame-1 is also stale.
        //   other methods: use the interpolated position at frame-1.
        const isPeak = (this.trackingMethod === 'highPeak' || this.trackingMethod === 'lowPeak');
        let prevPos;
        if (force) {
            prevPos = {x: this.trackX, y: this.trackY};
        } else if (isPeak) {
            prevPos = this.predictPosition(frame) ?? this.getRawInterpolatedPosition(frame - 1);
        } else {
            prevPos = this.getRawInterpolatedPosition(frame - 1);
        }
        if (!prevPos && this.trackingMethod === 'motion') prevPos = {x: this.trackX, y: this.trackY};
        if (!prevPos) return;

        const videoData = this.videoView?.videoData;
        if (!videoData) return;

        if (videoData.isFrameLoaded && !videoData.isFrameLoaded(frame)) return;
        const currImage = videoData.getImage(frame);

        if (!currImage || !currImage.width) return;

        // Algorithms operate in actual decoded image coords (pixel-level ops).
        // Tracker positions live in original-video coords. Scale at the
        // boundary: the wrapper converts prevPos and trackRadius/searchRadius
        // into image coords for the algorithm, then converts the algorithm's
        // output back to tracker coords.
        this.runAlgorithm(frame, currImage, prevPos, (img, pp) => {
            switch (this.trackingMethod) {
                case 'centerOnBright':
                    this.trackBrightCentroid(frame, img, pp);
                    break;
                case 'centerOnDark':
                    this.trackDarkCentroid(frame, img, pp);
                    break;
                case 'centerOnColor':
                    this.trackColorCentroid(frame, img, pp);
                    break;
                case 'highPeak':
                    this.trackPeak(frame, img, pp, true);
                    break;
                case 'lowPeak':
                    this.trackPeak(frame, img, pp, false);
                    break;
                case 'motion':
                    this.trackMotion(frame, img, pp, videoData);
                    break;
                case 'opticalflow':
                    this.trackOpticalFlow(frame, img, pp, videoData);
                    break;
                case 'template':
                default:
                    this.trackTemplateMatch(frame, img, pp, videoData);
                    break;
            }
        });
    }

    // Linear extrapolation from the two most recent tracked positions before
    // the given frame. Returns null if no prior positions exist; the single
    // prior position if only one exists. Used to seed peak-tracking so a fast-
    // moving feature is followed instead of latched to the stale position at
    // frame-1 (which is what trips up bright-centroid in dim sections).
    predictPosition(frame) {
        const priors = Array.from(this.trackedPositions.keys())
            .filter(f => f < frame)
            .sort((a, b) => a - b);
        if (priors.length === 0) return null;
        const recent = priors[priors.length - 1];
        if (priors.length === 1) return this.trackedPositions.get(recent);
        const older = priors[priors.length - 2];
        const p1 = this.trackedPositions.get(older);
        const p2 = this.trackedPositions.get(recent);
        const dt = recent - older;
        if (dt <= 0) return p2;
        return {
            x: p2.x + (p2.x - p1.x) * (frame - recent) / dt,
            y: p2.y + (p2.y - p1.y) * (frame - recent) / dt,
        };
    }

    trackPeak(frame, currImage, prevPos, isHigh) {
        const peak = this.findLocalPeak(
            currImage, prevPos.x, prevPos.y,
            this.searchRadius, this.featureSize, isHigh
        );
        if (peak) {
            this.trackX = peak.x;
            this.trackY = peak.y;
        } else {
            this.trackX = prevPos.x;
            this.trackY = prevPos.y;
        }
        this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
        this.updateSliderStatus();
    }

    // Find a local peak (max if isHigh, min if !isHigh) in a search ROI.
    // - Gaussian-blurs with sigma=featureSize to suppress noise and emphasise
    //   features of approximately that scale.
    // - Rejects line-like ridges via Hessian eigenvalue ratio (Harris-style).
    // - Relative-brightness gate: peak's *original* luminance must sit in the
    //   top 5% (high) or bottom 5% (low) of the ROI's pixels. This adapts to
    //   per-frame lighting where a fixed brightnessThreshold can't.
    // - Among qualifying peaks, picks the one with the largest *blurred*
    //   response — the blurred peak value already combines brightness and
    //   spatial extent (a wider/brighter blob retains more of its peak after
    //   blur than a sharp pixel-noise spike), so this approximates
    //   "brightest+largest" without measuring extent separately.
    // Returns {x, y} in IMAGE coords, or null if no qualifying peak.
    findLocalPeak(image, centerX, centerY, searchRadius, sigma, isHigh) {
        const imgW = image.width || image.videoWidth;
        const imgH = image.height || image.videoHeight;
        const minX = Math.max(0, Math.floor(centerX - searchRadius));
        const maxX = Math.min(imgW - 1, Math.ceil(centerX + searchRadius));
        const minY = Math.max(0, Math.floor(centerY - searchRadius));
        const maxY = Math.min(imgH - 1, Math.ceil(centerY + searchRadius));
        const roiW = maxX - minX + 1;
        const roiH = maxY - minY + 1;
        if (roiW < 5 || roiH < 5) return null;

        const luma = this.extractGrayROI(image, minX, minY, roiW, roiH);
        const blurred = sigma > 0.3 ? gaussianBlur1D(luma, roiW, roiH, sigma) : luma;
        const threshold = this.percentileLuma(luma, isHigh ? 0.95 : 0.05);

        let best = null;
        for (let y = 1; y < roiH - 1; y++) {
            for (let x = 1; x < roiW - 1; x++) {
                const v = blurred[y * roiW + x];
                // Strict 3x3 neighborhood peak (ties broken upper-left).
                let isPeak = true;
                for (let dy = -1; dy <= 1 && isPeak; dy++) {
                    for (let dx = -1; dx <= 1 && isPeak; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const nv = blurred[(y + dy) * roiW + (x + dx)];
                        if (isHigh ? nv >= v : nv <= v) {
                            if (nv === v && (dy < 0 || (dy === 0 && dx < 0))) isPeak = false;
                            else if (nv !== v) isPeak = false;
                        }
                    }
                }
                if (!isPeak) continue;

                // Relative-brightness gate (on the *original* ROI).
                const orig = luma[y * roiW + x];
                if (isHigh ? orig < threshold : orig > threshold) continue;

                // Hessian for blob-vs-line discrimination.
                const hxx = blurred[y * roiW + (x + 1)] - 2 * v + blurred[y * roiW + (x - 1)];
                const hyy = blurred[(y + 1) * roiW + x] - 2 * v + blurred[(y - 1) * roiW + x];
                const hxy = (blurred[(y + 1) * roiW + (x + 1)]
                           - blurred[(y + 1) * roiW + (x - 1)]
                           - blurred[(y - 1) * roiW + (x + 1)]
                           + blurred[(y - 1) * roiW + (x - 1)]) / 4;
                const det = hxx * hyy - hxy * hxy;
                const trace = hxx + hyy;
                if ((isHigh ? trace >= 0 : trace <= 0)) continue;
                if (det <= 0) continue;
                if ((trace * trace) / det > 12) continue;

                // "Brightest + largest" → highest |blurred| score wins.
                const score = isHigh ? v : -v;
                if (best === null || score > best.score) {
                    best = {x: x + minX, y: y + minY, score};
                }
            }
        }
        return best ? {x: best.x, y: best.y} : null;
    }

    // Stride-sampled percentile of a Float32Array, avoids sorting the full
    // luma plane on every frame. Stride scaled to give ~1024 samples max.
    percentileLuma(luma, p) {
        const stride = Math.max(1, Math.floor(luma.length / 1024));
        const sample = [];
        for (let i = 0; i < luma.length; i += stride) sample.push(luma[i]);
        sample.sort((a, b) => a - b);
        const idx = Math.max(0, Math.min(sample.length - 1, Math.floor(sample.length * p)));
        return sample[idx];
    }

    extractGrayROI(image, minX, minY, roiW, roiH) {
        const canvas = document.createElement('canvas');
        canvas.width = roiW;
        canvas.height = roiH;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, minX, minY, roiW, roiH, 0, 0, roiW, roiH);
        const imgData = ctx.getImageData(0, 0, roiW, roiH);
        const luma = new Float32Array(roiW * roiH);
        for (let i = 0; i < roiW * roiH; i++) {
            const k = i * 4;
            luma[i] = 0.299 * imgData.data[k] + 0.587 * imgData.data[k + 1] + 0.114 * imgData.data[k + 2];
        }
        return luma;
    }

    runAlgorithm(frame, currImage, prevPos, fn) {
        const vd = this.videoView?.videoData;
        const origW = vd?.originalVideoWidth, origH = vd?.originalVideoHeight;
        if (!origW || !origH) {
            // No reference resolution available — algorithm coords match
            // tracker coords. Pass through.
            fn(currImage, prevPos);
            return;
        }
        const w = currImage.width || currImage.videoWidth;
        const h = currImage.height || currImage.videoHeight;
        if (!w || !h) { fn(currImage, prevPos); return; }
        const sx = w / origW, sy = h / origH;

        // Scale prevPos and radii into image coords
        const ip = {x: prevPos.x * sx, y: prevPos.y * sy};
        const trackRadiusTracker = this.trackRadius;
        const searchRadiusTracker = this.searchRadius;
        const cursor = {x: this.trackX, y: this.trackY};
        // Even a waiting/no-result branch must leave image coordinates here.
        // Otherwise the finally block scales an untouched original coordinate
        // a second time on reduced-resolution decodes.
        this.trackX *= sx;
        this.trackY *= sy;
        this.trackRadius = trackRadiusTracker * sx;
        this.searchRadius = searchRadiusTracker * sx;
        try {
            fn(currImage, ip);
        } catch (e) {
            this.trackX = cursor.x * sx;
            this.trackY = cursor.y * sy;
            throw e;
        } finally {
            this.trackRadius = trackRadiusTracker;
            this.searchRadius = searchRadiusTracker;
            // Algorithm wrote trackX/Y and trackedPositions[frame] in image
            // coords; map both back to tracker coords.
            this.trackX = this.trackX * origW / w;
            this.trackY = this.trackY * origH / h;
            const position = this.trackedPositions.get(frame);
            if (position) this.trackedPositions.set(frame, {...position, x: this.trackX, y: this.trackY});
        }
    }

    // Scan the disk of `radius` around (centerX, centerY) for the best-scoring
    // pixel under `weightFn`, where score = weight × radial falloff. The falloff
    // (1 at the centre, 0 at the rim) biases the seed toward the previous
    // position, so a bright-and-near target beats a brighter-but-distant cloud
    // — without it a global maximum over a large window jumps to whatever blob
    // happens to be brightest anywhere in range. Returns {x, y} in image coords,
    // or null if nothing qualified.
    //
    // This is the "catch" pass for the Center-on-* methods: it is run over the
    // SEARCH radius so a feature that moved more than a Track Radius between
    // frames is still re-acquired (the old code only looked inside the Track
    // Radius, so any motion larger than that silently lost the track).
    findBestWeightedPixel(image, centerX, centerY, radius, weightFn) {
        const imgWidth = image.width || image.videoWidth;
        const imgHeight = image.height || image.videoHeight;

        const minX = Math.max(0, Math.floor(centerX - radius));
        const maxX = Math.min(imgWidth - 1, Math.ceil(centerX + radius));
        const minY = Math.max(0, Math.floor(centerY - radius));
        const maxY = Math.min(imgHeight - 1, Math.ceil(centerY + radius));
        const roiWidth = maxX - minX + 1;
        const roiHeight = maxY - minY + 1;
        if (roiWidth < 1 || roiHeight < 1) return null;

        const canvas = document.createElement('canvas');
        canvas.width = imgWidth;
        canvas.height = imgHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(image, 0, 0, imgWidth, imgHeight);
        const data = ctx.getImageData(minX, minY, roiWidth, roiHeight).data;

        const radiusSquared = radius * radius;
        const invRadius = radius > 0 ? 1 / radius : 0;
        let bestScore = 0, bestX = -1, bestY = -1;
        for (let roiY = 0; roiY < roiHeight; roiY++) {
            for (let roiX = 0; roiX < roiWidth; roiX++) {
                const imgX = minX + roiX;
                const imgY = minY + roiY;
                const dx = imgX - centerX;
                const dy = imgY - centerY;
                const dist2 = dx * dx + dy * dy;
                if (dist2 > radiusSquared) continue;
                const index = (roiY * roiWidth + roiX) * 4;
                const w = weightFn(data[index], data[index + 1], data[index + 2]);
                if (w <= 0) continue;
                const falloff = 1 - Math.sqrt(dist2) * invRadius;  // 1 at centre → 0 at rim
                const score = w * falloff;
                if (score > bestScore) {
                    bestScore = score;
                    bestX = imgX;
                    bestY = imgY;
                }
            }
        }
        if (bestX < 0) return null;
        return {x: bestX, y: bestY};
    }

    // Shared two-stage tracker for all three centroid-based methods:
    //   1. SEARCH RADIUS pass — find the strongest matching pixel anywhere
    //      within searchRadius of the previous position (re-acquisition).
    //   2. TRACK RADIUS pass — refine to the weighted centroid of the matching
    //      pixels within trackRadius of that seed, so the reported point isn't
    //      dragged off by unrelated bright pixels elsewhere in the window.
    // Falls back to the seed (then the previous position) when nothing matched.
    _trackCentroid(frame, currImage, prevPos, weightFn) {
        const seed = this.findBestWeightedPixel(
            currImage, prevPos.x, prevPos.y, this.searchRadius, weightFn) ?? prevPos;
        const centroid = this.calculateWeightedCentroid(
            currImage, seed.x, seed.y, this.trackRadius, weightFn);
        if (centroid) {
            this.trackX = centroid.x;
            this.trackY = centroid.y;
        } else {
            this.trackX = seed.x;
            this.trackY = seed.y;
        }
        this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
        this.updateSliderStatus();
    }

    trackBrightCentroid(frame, currImage, prevPos) {
        this._trackCentroid(frame, currImage, prevPos, (r, g, b) => this._brightWeight(r, g, b));
    }

    trackDarkCentroid(frame, currImage, prevPos) {
        this._trackCentroid(frame, currImage, prevPos, (r, g, b) => this._darkWeight(r, g, b));
    }

    trackColorCentroid(frame, currImage, prevPos) {
        this._trackCentroid(frame, currImage, prevPos, (r, g, b) => this._colorWeight(r, g, b));
    }

    // Background-motion tracking. Unlike every other method here, this one does
    // not ask what the target looks like — it asks which pixels disagree with
    // the motion of the background around them. That is what lets it follow a
    // target across clutter it is indistinguishable from.
    //
    // The heavy lifting is in MotionBackgroundTracker; this wrapper supplies the
    // prediction, decides whether a detection is trustworthy, and coasts on the
    // last known velocity when it is not.
    // Median of recent accepted detection scores — what a good detection looks
    // like in THIS clip. Zero until enough have been seen to be meaningful.
    motionTypicalScore() {
        if (this.motionScores.length < 5) return 0;
        const sorted = [...this.motionScores].sort((a, b) => a - b);
        return sorted[sorted.length >> 1];
    }

    anchorMotionPoint(frame, point) {
        if (this.trackingMethod !== 'motion') return;
        const videoData = this.videoView?.videoData;
        const sx = (videoData?.videoWidth || 1) / (videoData?.originalVideoWidth || videoData?.videoWidth || 1);
        const sy = (videoData?.videoHeight || 1) / (videoData?.originalVideoHeight || videoData?.videoHeight || 1);
        if (this.motionOffscreen && this.motionTracker && this.motionAnchors.length) {
            this.motionTracker.recordCameraMotion(videoData, frame,
                {gap: this.motionGap, samples: this.motionSamples, mask: this.getMotionMask()});
            const previous = this.motionAnchors[this.motionAnchors.length - 1];
            const gap = this.motionTracker.cameraPath.reconstruct(previous, {frame, x: point.x * sx, y: point.y * sy});
            if (gap) for (const [f, p] of gap) {
                if (!this.isUserPoint(f)) this.trackedPositions.set(f,
                    {x: p.x / sx, y: p.y / sy, estimated: 'background'});
            }
        }
        anchorsFromUserPoint(this, frame, point.x * sx, point.y * sy);
    }

    getMotionMask() {
        const mask = this.useMask ? NodeMan.get('videoMask', false) : null;
        return mask?.maskImageData ? {imageData: mask.maskImageData, revision: mask.maskRevision} : null;
    }

    trackMotion(frame, currImage, prevPos, videoData) {
        if (!cv) return;
        if (!this.motionTracker) this.motionTracker = new MotionBackgroundTracker(cv);

        // A jump backwards, or a gap, means the caller is no longer walking
        // forward through the clip, so the cached homography chain no longer
        // describes the frames being asked about.
        if (this.motionLastFrame === null || frame <= this.motionLastFrame ||
            frame - this.motionLastFrame > 4 * this.motionGap) {
            this.motionTracker.reset();
            this.motionMisses = 0;
            this.motionOffscreen = false;
            this.motionReacquisition.reset();
            this.motionRegime.reset();
            this.motionAnchors = [];
            this.motionCandidate = null;
            this.motionScores = [];
            this.motionTrail = [];
        }
        this.motionLastFrame = frame;

        const width = currImage.width || currImage.videoWidth;
        const height = currImage.height || currImage.videoHeight;
        // Keep numeric camera transforms even on frames where a wide search is
        // skipped. The decoded images and OpenCV matrices remain bounded.
        this.motionTracker.recordCameraMotion(videoData, frame, {
            gap: this.motionGap, samples: this.motionSamples, mask: this.getMotionMask(),
        });
        const cameraPath = this.motionTracker.cameraPath;
        this.motionRegime.updateCamera(cameraPath, frame, width, height);

        // The gate is aimed from ANCHORS — frames where the object was actually
        // measured — never from positions this method wrote itself. That
        // distinction is the whole stability story: a prediction derived from
        // its own previous output feeds back on itself, so one bad frame shifts
        // the gate, which makes the next frame worse, and the track walks off the
        // screen. Anchored, a run of misses cannot compound, because the anchor
        // it is measured from does not move.
        const anchors = this.motionAnchors;
        const last = anchors.length ? anchors[anchors.length - 1] : null;
        let speed = 0;
        if (anchors.length >= 2) {
            const before = anchors[anchors.length - 2];
            const span = last.frame - before.frame;
            if (span > 0) speed = Math.hypot(last.x - before.x, last.y - before.y) / span;
        }
        let searching = this.motionMisses > this.motionMaxCoast || this.motionOffscreen;
        const cameraTransition = frame <= this.motionRegime.transitionUntil;
        // A ground lock removes camera motion, not the object's own motion.
        // Its former small screen speed must not cap the next search when the
        // target now crosses a stationary image at its relative-ground speed.
        if (searching || cameraTransition) speed = Math.max(speed, this.motionRegime.relativeSpeed);

        // An unconfirmed candidate still steers the search, even though it is not
        // yet trusted enough to anchor. Without this the gate stays behind at the
        // old anchor, the object leaves it, and the corroborating sighting can
        // never arrive — the check meant to protect the track would be what
        // destroys it.
        // Only a SURPRISING candidate steers the search — one found while the
        // tracker still basically knew where the object was, which jumped
        // further than expected. Following that for a frame is how a real jolt
        // gets confirmed instead of lost.
        //
        // A candidate from the wide re-acquisition search must not steer. Doing
        // so both narrows the gate and stops the periodic wide sweep, so one
        // marginal peak parks the search on empty ground for ten frames at a
        // time; measured on the turbine clip that alone took a healthy 92% track
        // down to 51% and shredded it into fragments.
        //
        // It must also be about as convincing as what this clip has actually
        // been yielding, judged against a running median rather than a fixed
        // number, because what counts as a strong detection differs per clip.
        const typical = this.motionTypicalScore();
        const cand = this.motionCandidate;
        const pending = cand && !cand.fromSearch &&
            (frame - cand.frame) <= 2 * this.motionReacquireEvery &&
            cand.score >= 0.8 * typical ? cand : null;

        let predicted = prevPos;
        if (pending) {
            predicted = {x: pending.x, y: pending.y};
        } else if (last && !searching) {
            // A brief dropout: the object is very likely still going the way it
            // was, so follow it.
            let vx = 0, vy = 0;
            if (anchors.length >= 2) {
                const before = anchors[anchors.length - 2];
                const span = last.frame - before.frame;
                if (span > 0) {
                    vx = (last.x - before.x) / span;
                    vy = (last.y - before.y) / span;
                }
            }
            const ahead = frame - last.frame;
            predicted = {x: last.x + vx * ahead, y: last.y + vy * ahead};
        } else if (last) {
            // Genuinely lost. Do NOT keep extrapolating: the velocity measured
            // just before a loss says nothing about where the object is now, and
            // it routinely points the search the wrong way — measured on this
            // clip, the object was last seen moving left, immediately went right,
            // and the extrapolated gate chased it into empty desert for 185
            // frames while the object sat at 14 sigma just outside the search.
            // Search around where it was last SEEN instead.
            predicted = {x: last.x, y: last.y};
        }
        const imagePrediction = predicted;
        const cameraPrediction = last ? cameraPath.predict(anchors, frame) ||
            this.motionRegime.stationaryPrediction(last, frame) : null;
        // Camera slews affect an on-screen target too. A screen-velocity-only
        // predictor lags a reversal and can abandon a clearly visible object.
        if (!pending && !searching && cameraPrediction) predicted = cameraPrediction;
        const edge = Math.max(10, 3 * this.featureSize);
        const outside = p => p && (p.x < edge || p.x >= width - edge || p.y < edge || p.y >= height - edge);
        // A target crossing the image edge cannot turn into a nearby OSD mark.
        // Keep its camera-compensated prediction private until a return is seen.
        const nearEdge = last && (last.x < edge + this.searchRadius || last.x > width - edge - this.searchRadius ||
            last.y < edge + this.searchRadius || last.y > height - edge - this.searchRadius);
        if (nearEdge && outside(predicted)) this.motionOffscreen = true;
        if (this.motionOffscreen) {
            searching = true;
            predicted = cameraPrediction || predicted;
        }
        // An off-screen prediction is a search hint, not proof of absence.
        // Periodically inspect the whole image even if that prediction has
        // drifted away. Use independent multi-frame confirmation for this sweep.
        const elapsed = last ? frame - last.frame : 0;
        const broadReturn = this.motionOffscreen && elapsed > this.motionMaxCoast &&
            elapsed % (3 * this.motionReacquireEvery) === 0;
        const temporalSearch = searching && (!this.motionOffscreen || broadReturn);
        const seedX = broadReturn ? width / 2 : Math.min(width - edge, Math.max(edge, predicted.x));
        const seedY = broadReturn ? height / 2 : Math.min(height - edge, Math.max(edge, predicted.y));

        // While the object is lost the search has to cover everywhere it could
        // have got to, which is (time since it was last seen) x (how fast it was
        // going) — not some fixed multiple of the frame-to-frame gate. Sizing it
        // by uncertainty rather than by a constant is the difference between
        // re-acquiring and never seeing it again.
        const maxGate = searching && !this.motionOffscreen
            ? Math.hypot(width, height) : Math.min(width, height) / 5;
        // Even when merely following, the gate has to allow for the object's own
        // speed. Search Radius says how far beyond the PREDICTED position to
        // look, but the prediction is only as good as the velocity estimate, and
        // a manoeuvring object's velocity is uncertain by roughly its own speed.
        // Measured on a hand-slewed clip: the object accelerated to 20 px/frame
        // while the gate was 20 px, so it sat exactly on the boundary and fell
        // out — detection was 11-28 sigma at every one of those frames, with the
        // runner-up under 4, so nothing was ambiguous. The track was lost purely
        // by looking in a place a fraction too small.
        // One rule for how far to look, growing with how long it has been since
        // the object was actually seen: Search Radius, plus the distance it
        // could have travelled in that time at its own speed. A constant gate
        // during a dropout is why an intermittently-visible object gets lost —
        // measured on one clip, detections of 7-10 sigma were sitting there
        // unfound at frames 143 to 167 simply because the gate was still centred
        // where the object had been ten frames earlier.
        const gate = broadReturn ? Math.hypot(width, height) : pending
            ? this.searchRadius + speed
            : Math.min(maxGate, this.searchRadius + Math.max(2, speed) * Math.max(1, elapsed));
        // A wider search gives noise more chances to clear the threshold, so
        // what comes back has to be convincing rather than merely present.
        const bar = searching ? this.motionThreshold * 1.5 : this.motionThreshold;

        // Re-acquiring over a wide area costs far more than a normal step, so do
        // it periodically rather than every frame — a couple of times a second is
        // ample for an object that has already been missing for a while, and the
        // frames in between get filled in by interpolation once it is found.
        if (searching && !pending && !cameraTransition && (elapsed % this.motionReacquireEvery) !== 0) {
            this.motionMisses++;
            this.trackedPositions.markUnmeasured(frame);
            return;
        }

        const measureOptions = {
            gap: this.motionGap,
            samples: this.motionSamples,
            gate,
            targetRadius: this.trackRadius,
            // Feature Size is the scale of the thing being detected; Track Radius
            // is how big the object is. For a small point target they are very
            // different numbers, and using the latter for both loses the target.
            featureScale: this.featureSize,
            slack: this.motionSlack,
            polarity: this.motionPolarity,
            preferNear: true,
            requireAppearance: temporalSearch,
            maxCandidates: temporalSearch ? 12 : 1,
            mask: this.getMotionMask(),
            firstFrame: Sit.aFrame ?? 0,
            lastFrame: Sit.bFrame ?? (Sit.frames - 1),
        };
        let hit = this.motionOffscreen && !broadReturn && cameraPrediction &&
            (predicted.x < -gate || predicted.x > width + gate || predicted.y < -gate || predicted.y > height + gate)
            ? null : this.motionTracker.measure(videoData, frame, seedX, seedY, measureOptions);
        const clearHit = h => h && !h.waiting && h.score >= bar && h.score >= 1.6 * Math.max(h.second, 1e-6);
        // Both motion models can explain a valid observation, so both must get
        // a chance to find it. A bad background fit can move its gate away from
        // a smoothly continuing target well before the camera-state detector
        // can confirm a transition. Try the observed image trajectory when the
        // camera-centered search is ambiguous; require the same clear peak.
        if (!searching && !pending && cameraPrediction && !clearHit(hit) &&
            Math.hypot(imagePrediction.x - predicted.x, imagePrediction.y - predicted.y) > this.motionMinJump) {
            const alternative = this.motionTracker.measure(videoData, frame,
                imagePrediction.x, imagePrediction.y, measureOptions);
            if (clearHit(alternative)) hit = alternative;
        }

        if (hit && hit.waiting) {
            // The background window has not been decoded yet — tracking starts at
            // the seed frame, so there is no history behind it. Hold exactly
            // still: coasting here would walk the gate away from a target that
            // has not actually been looked for.
            this.trackedPositions.markUnmeasured(frame);
            return;
        }

        // Accept only a detection that is strong in absolute terms AND clearly
        // stronger than the next peak in the gate. An ambiguous gate is how a
        // tracker silently steps onto clutter and never comes back.
        let temporalReturn = false;
        if (temporalSearch) {
            const before = anchors[Math.max(0, anchors.length - 6)];
            const old = before && cameraPath.transport(before, before.frame, last.frame);
            const relativeSpeed = old && last.frame > before.frame
                ? Math.hypot(last.x - old.x, last.y - old.y) / (last.frame - before.frame) : speed;
            const confirmed = this.motionReacquisition.update(frame, hit?.candidates || [], cameraPath, {
                threshold: bar, scale: this.featureSize, speed: Math.max(relativeSpeed, this.motionRegime.relativeSpeed),
                interval: this.motionReacquireEvery * (broadReturn ? 3 : 1), coherence: this.motionCoherence,
            });
            if (confirmed) { hit = confirmed; temporalReturn = true; }
        }
        let trusted = temporalReturn || ((!searching || (this.motionOffscreen && !broadReturn)) && hit && hit.score >= bar &&
            hit.score >= 1.6 * Math.max(hit.second, 1e-6));

        // A strong peak is not enough: it also has to be somewhere the object
        // could actually have got to. Without this, the first false peak after a
        // brief dropout becomes the new anchor and the track walks away from a
        // target it had been holding perfectly — measured on a clip whose object
        // drifts at under 1 px/frame, a peak 130 px away was accepted four frames
        // after the object dimmed behind a dark turbine.
        //
        // Only while merely coasting, though. Re-acquisition after a real loss is
        // exactly the case where the object legitimately turns up somewhere else,
        // and there the widened search and raised bar do the filtering instead.
        // How far the object could plausibly be from where it was last seen: as
        // far as its own speed carries it, plus a fixed tolerance and a small
        // allowance for manoeuvre. Note this is a DISTANCE, not a per-frame rate
        // multiplied by the gap — an object does not speed up merely because we
        // stopped seeing it, and treating the allowance as per-frame lets a
        // five-frame dropout admit a 50 px jump.
        const reach = (step) => speed * step + this.motionMinJump + 0.5 * step;
        let surprising = false;
        if (trusted && last && !searching) {
            const step = Math.max(1, frame - last.frame);
            // Registration can briefly follow a different depth plane. A point
            // continuing its observed screen motion is still plausible even
            // when that camera prediction disagrees; either model can explain
            // the step, but a jump unexplained by both needs corroboration.
            surprising = Math.hypot(hit.x - last.x, hit.y - last.y) > reach(step) &&
                (!cameraPrediction || Math.hypot(hit.x - cameraPrediction.x, hit.y - cameraPrediction.y) > reach(step));
        }

        // Two kinds of detection are not believed on their own: one found by the
        // wide re-acquisition search, and one that implies a jump the object
        // should not have been able to make. Both are held as a candidate and
        // only become the new anchor once a second sighting turns up somewhere
        // the object could have moved to since. Noise does not repeat in the same
        // place; an object does.
        //
        // Corroboration rather than rejection, because a threshold cannot tell
        // these apart: measured across the two test clips, a spurious jump was
        // 5.2x the object's own speed and a perfectly good one — a hand-slewed
        // camera jolting 22 px in a single frame — was 4.2x. Rejecting the first
        // by threshold necessarily rejects the second, and losing one true
        // detection is enough to unravel everything after it.
        if (trusted && !temporalReturn && (searching || surprising)) {
            const seen = this.motionCandidate;
            const gap2 = seen ? frame - seen.frame : 0;
            // Two different questions, because the two cases fail differently.
            //
            // From the WIDE search, the gate spans a fifth of the frame, so the
            // risk is two unrelated noise peaks vouching for each other:
            // consistency has to be tight, measured against how far the object
            // could actually have travelled.
            //
            // From a SURPRISING detection the risk is the opposite — the bound
            // must not be the object's OLD speed, because the reason it looked
            // surprising is that it stopped moving at that speed. So instead of
            // asking "is it close?", ask "are these sightings COHERENT?" — three
            // in a row on a near-constant velocity. Measured on a hand-slewed
            // clip the object accelerated to 21 px/frame with a second
            // difference of 0.5 px/frame^2, unmistakably a moving object, while
            // post-loss noise on the turbine clip is strong but never coherent.
            // This asks nothing about the previous speed, so real acceleration
            // is accepted and noise is not.
            let confirms;
            if (seen && seen.fromSearch) {
                const expected = this.motionOffscreen
                    ? cameraPath.predict([last, seen], frame) || seen : seen;
                confirms = gap2 > 0 && gap2 <= 3 * this.motionReacquireEvery &&
                    Math.hypot(hit.x - expected.x, hit.y - expected.y) <=
                        (this.motionOffscreen ? this.motionMinJump + 0.5 * gap2 : reach(gap2));
            } else {
                const trail = this.motionTrail;
                if (trail.length && frame - trail[trail.length - 1].frame > 3) trail.length = 0;
                trail.push({frame, x: hit.x, y: hit.y});
                if (trail.length > 3) trail.shift();
                confirms = false;
                if (trail.length === 3) {
                    const [a, b, c] = trail;
                    const dt1 = b.frame - a.frame, dt2 = c.frame - b.frame;
                    if (dt1 > 0 && dt2 > 0) {
                        const change = Math.hypot(
                            (c.x - b.x) / dt2 - (b.x - a.x) / dt1,
                            (c.y - b.y) / dt2 - (b.y - a.y) / dt1);
                        confirms = change <= this.motionCoherence;
                    }
                }
                if (confirms) this.motionTrail = [];
            }
            if (confirms) {
                this.motionCandidate = null;
            } else {
                this.motionCandidate = {frame, x: hit.x, y: hit.y, score: hit.score,
                    fromSearch: searching};
                trusted = false;
            }
        }
        if (trusted) this.motionCandidate = null;

        if (trusted) {
            this.motionScores.push(hit.score);
            if (this.motionScores.length > 20) this.motionScores.shift();
            const previous = anchors.length ? anchors[anchors.length - 1] : null;
            // Only confirmed endpoints authorize an estimated gap. Use the
            // measured camera path for an off-screen interval; a straight image
            // line would ignore the slew that made the target disappear.
            if (previous && frame - previous.frame > 1) {
                const toTracker = (videoData?.originalVideoWidth || width) / width;
                const toTrackerY = (videoData?.originalVideoHeight || height) / height;
                // Background fits can switch depth planes at a tower crossing.
                // Importing those per-frame shifts into an ordinary short gap
                // invents spikes even when its endpoints follow a smooth track.
                // Reserve camera reconstruction for an actual edge excursion;
                // in-frame losses reconnect the confirmed image observations.
                const reconstructed = this.motionOffscreen
                    ? cameraPath.reconstruct(previous, {frame, x: hit.x, y: hit.y}) : null;
                const span = frame - previous.frame;
                for (let f = previous.frame + 1; f < frame; f++) {
                    if (this.isUserPoint(f)) continue;
                    const t = (f - previous.frame) / span;
                    const p = reconstructed?.get(f) || (!this.motionOffscreen ? {
                        x: previous.x + (hit.x - previous.x) * t,
                        y: previous.y + (hit.y - previous.y) * t,
                    } : null);
                    // Missing/failed registration leaves a visible gap, not an
                    // invented claim that the camera stood still.
                    if (p) this.trackedPositions.set(f, {
                        x: p.x * toTracker, y: p.y * toTrackerY,
                        estimated: reconstructed ? 'background' : 'linear',
                    });
                }
            }
            anchors.push({frame, x: hit.x, y: hit.y});
            this.motionRegime.observeTarget({frame, x: hit.x, y: hit.y}, cameraPath);
            if (anchors.length > 8) anchors.shift();
            this.trackX = hit.x;
            this.trackY = hit.y;
            this.motionMisses = 0;
            this.motionOffscreen = false;
            this.motionReacquisition.reset();
            this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
        } else {
            // Keep the last visible cursor for editing, but publish no guessed
            // position while searching. Reacquisition backfills confirmed gaps.
            this.motionMisses++;
            this.trackedPositions.markUnmeasured(frame);
        }
        if (this.motionDebug) {
            this.motionDebug.push({
                f: frame, ok: trusted ? 1 : 0,
                s: hit ? +hit.score.toFixed(1) : -1,
                r: hit ? +hit.second.toFixed(1) : -1,
                g: +gate.toFixed(0), b: +bar.toFixed(1),
                n: hit ? (hit.samples || 0) : 0,
                m: this.motionMisses, offscreen: this.motionOffscreen,
                background: this.motionRegime.state,
                backgroundSpeed: this.motionRegime.cameraSpeed,
                px: cameraPrediction ? +cameraPrediction.x.toFixed(1) : null,
                py: cameraPrediction ? +cameraPrediction.y.toFixed(1) : null,
                x: +this.trackX.toFixed(1), y: +this.trackY.toFixed(1),
                hx: hit && hit.x !== undefined ? +hit.x.toFixed(1) : null,
                hy: hit && hit.y !== undefined ? +hit.y.toFixed(1) : null,
            });
            if (this.motionDebug.length > 4000) this.motionDebug.shift();
        }
        this.updateSliderStatus();
    }

    trackTemplateMatch(frame, currImage, prevPos, videoData) {
        if (!cv) return;

        const width = currImage.width || currImage.videoWidth;
        const height = currImage.height || currImage.videoHeight;

        const currCanvas = document.createElement('canvas');
        currCanvas.width = width;
        currCanvas.height = height;
        const currCtx = currCanvas.getContext('2d');
        currCtx.drawImage(currImage, 0, 0, width, height);
        const currImageData = currCtx.getImageData(0, 0, width, height);

        const currMat = cv.matFromImageData(currImageData);
        const currGray = new cv.Mat();
        cv.cvtColor(currMat, currGray, cv.COLOR_RGBA2GRAY);

        // Capture initial template on first tracking frame (prevents drift)
        if (!this.initialTemplate || this.initialTemplateFrame === null) {
            const templateSize = this.trackRadius * 2;
            const templateX = Math.max(0, Math.floor(prevPos.x - this.trackRadius));
            const templateY = Math.max(0, Math.floor(prevPos.y - this.trackRadius));
            const templateW = Math.min(templateSize, width - templateX);
            const templateH = Math.min(templateSize, height - templateY);

            const templateROI = currGray.roi(new cv.Rect(templateX, templateY, templateW, templateH));
            this.initialTemplate = templateROI.clone();
            templateROI.delete();
            this.initialTemplateFrame = frame;
            
            this.trackX = prevPos.x;
            this.trackY = prevPos.y;
            this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
            this.updateSliderStatus();
            currMat.delete();
            currGray.delete();
            return;
        }

        const templateW = this.initialTemplate.cols;
        const templateH = this.initialTemplate.rows;

        // Search area centered on previous position
        const searchX = Math.max(0, Math.floor(prevPos.x - this.searchRadius));
        const searchY = Math.max(0, Math.floor(prevPos.y - this.searchRadius));
        const searchW = Math.min(this.searchRadius * 2, width - searchX);
        const searchH = Math.min(this.searchRadius * 2, height - searchY);

        if (searchW <= templateW || searchH <= templateH) {
            this.trackX = prevPos.x;
            this.trackY = prevPos.y;
            this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
            currMat.delete();
            currGray.delete();
            return;
        }

        const searchArea = currGray.roi(new cv.Rect(searchX, searchY, searchW, searchH));

        const result = new cv.Mat();
        cv.matchTemplate(searchArea, this.initialTemplate, result, cv.TM_CCOEFF_NORMED);

        const minMax = cv.minMaxLoc(result);
        
        const bestX = searchX + minMax.maxLoc.x + templateW / 2;
        const bestY = searchY + minMax.maxLoc.y + templateH / 2;

        this.trackX = bestX;
        this.trackY = bestY;
        this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
        this.updateSliderStatus();

        currMat.delete();
        currGray.delete();
        searchArea.delete();
        result.delete();
    }

    trackOpticalFlow(frame, currImage, prevPos, videoData) {
        const jsfeat = getJsfeat();
        if (!jsfeat) {
            console.warn("Optical flow: jsfeat not loaded");
            return;
        }

        const width = currImage.width || currImage.videoWidth;
        const height = currImage.height || currImage.videoHeight;

        const currCanvas = document.createElement('canvas');
        currCanvas.width = width;
        currCanvas.height = height;
        const currCtx = currCanvas.getContext('2d');
        currCtx.drawImage(currImage, 0, 0, width, height);
        const currImageData = currCtx.getImageData(0, 0, width, height);

        const currGray = new jsfeat.matrix_t(width, height, jsfeat.U8_t | jsfeat.C1_t);
        jsfeat.imgproc.grayscale(currImageData.data, width, height, currGray);

        if (!this.initialPyramid || !this.initialKeypoints) {
            const roiX = Math.max(0, Math.floor(prevPos.x - this.trackRadius));
            const roiY = Math.max(0, Math.floor(prevPos.y - this.trackRadius));
            const roiW = Math.min(this.trackRadius * 2, width - roiX);
            const roiH = Math.min(this.trackRadius * 2, height - roiY);

            if (roiW < 11 || roiH < 7) {
                this.trackX = prevPos.x;
                this.trackY = prevPos.y;
                this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
                this.updateSliderStatus();
                return;
            }

            this.initialGrayImage = currGray;
            const pyrLevels = 3;
            this.initialPyramid = new jsfeat.pyramid_t(pyrLevels);
            this.initialPyramid.allocate(width, height, jsfeat.U8_t | jsfeat.C1_t);
            this.initialPyramid.build(currGray, false);

            const cornerMat = new jsfeat.matrix_t(roiW, roiH, jsfeat.U8_t | jsfeat.C1_t);
            for (let y = 0; y < roiH; y++) {
                for (let x = 0; x < roiW; x++) {
                    cornerMat.data[y * roiW + x] = currGray.data[(roiY + y) * width + (roiX + x)];
                }
            }

            const maxCorners = Math.ceil((roiW * roiH) / 4);
            const cornersArray = [];
            for (let i = 0; i < maxCorners; i++) {
                cornersArray.push(new jsfeat.keypoint_t(0, 0, 0, 0));
            }

            jsfeat.yape06.laplacian_threshold = 30;
            jsfeat.yape06.min_eigen_value_threshold = 25;
            const detectedCount = jsfeat.yape06.detect(cornerMat, cornersArray, 5);
            const count = Math.min(detectedCount, 100);

            if (count === 0) {
                this.trackX = prevPos.x;
                this.trackY = prevPos.y;
                this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
                this.updateSliderStatus();
                this.initialPyramid = null;
                return;
            }

            this.initialKeypoints = new Float32Array(count * 2);
            for (let i = 0; i < count; i++) {
                this.initialKeypoints[i * 2] = roiX + cornersArray[i].x;
                this.initialKeypoints[i * 2 + 1] = roiY + cornersArray[i].y;
            }
            this.initialCenter = {x: prevPos.x, y: prevPos.y};

            this.trackX = prevPos.x;
            this.trackY = prevPos.y;
            this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
            this.updateSliderStatus();
            return;
        }

        const pyrLevels = 3;
        const currPyr = new jsfeat.pyramid_t(pyrLevels);
        currPyr.allocate(width, height, jsfeat.U8_t | jsfeat.C1_t);
        currPyr.build(currGray, false);

        const count = this.initialKeypoints.length / 2;
        const currXY = new Float32Array(count * 2);
        const status = new Uint8Array(count);

        const winSize = 21;
        const maxIterations = 30;
        const epsilon = 0.01;
        const minEigen = 0.0001;

        jsfeat.optical_flow_lk.track(
            this.initialPyramid, currPyr,
            this.initialKeypoints, currXY,
            count,
            winSize, maxIterations, status, epsilon, minEigen
        );

        let sumX = 0, sumY = 0, validCount = 0;
        for (let i = 0; i < count; i++) {
            if (status[i] === 1) {
                const initialX = this.initialKeypoints[i * 2];
                const initialY = this.initialKeypoints[i * 2 + 1];
                const currX = currXY[i * 2];
                const currY = currXY[i * 2 + 1];
                const dx = currX - initialX;
                const dy = currY - initialY;
                if (Math.abs(dx) < this.searchRadius && Math.abs(dy) < this.searchRadius) {
                    sumX += currX;
                    sumY += currY;
                    validCount++;
                }
            }
        }

        if (validCount > 0) {
            const avgX = sumX / validCount;
            const avgY = sumY / validCount;
            const initialAvgX = this.initialKeypoints.reduce((sum, v, i) => i % 2 === 0 ? sum + v : sum, 0) / count;
            const initialAvgY = this.initialKeypoints.reduce((sum, v, i) => i % 2 === 1 ? sum + v : sum, 0) / count;
            this.trackX = this.initialCenter.x + (avgX - initialAvgX);
            this.trackY = this.initialCenter.y + (avgY - initialAvgY);
        } else {
            this.trackX = prevPos.x;
            this.trackY = prevPos.y;
        }

        this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
        this.updateSliderStatus();
    }
    
    // Returns the per-pixel weight function used by the centroid algorithm
    // for the current tracking method, or null if the method has no weight
    // rule (template/optical flow/peak/sam2 — no preview to draw).
    _currentWeightFn() {
        switch (this.trackingMethod) {
            case 'centerOnBright': return (r, g, b) => this._brightWeight(r, g, b);
            case 'centerOnDark':   return (r, g, b) => this._darkWeight(r, g, b);
            case 'centerOnColor':  return (r, g, b) => this._colorWeight(r, g, b);
            default:               return null;
        }
    }

    // A user point resets the tracker's idea of where the object is: it becomes
    // the newest anchor, any pending candidate is dropped, and the miss count
    // goes back to zero. Without that the tracker would keep aiming from a stale
    // anchor and ignore the correction it was just handed.
    // (Defined as a free function so trackMotion reads in one line.)

    // Measure the object under the cursor and set the motion settings to suit
    // it, once, instead of leaving the user to guess or the tracker to re-decide
    // every frame.
    //
    // The two clips this was built against sit at opposite ends of the range —
    // a 3 px dot on a smooth background, and an amorphous blob on heavily
    // textured terrain — and no single set of numbers serves both. But the
    // settings that DO serve each are measurable in a couple of seconds: sweep
    // detection scale, polarity and parallax slack at the seed point and keep
    // whichever combination makes the object stand out most against its own
    // surroundings. Doing it once and committing is what keeps the track stable;
    // re-deciding per frame lets a wrong choice win occasionally and fragments
    // the result.
    async analyseObject(onProgress) {
        const session = beginVideoAnalysis(this.videoView?.videoData);
        try {
            return await this.analyseObjectAtResolution(onProgress, session);
        } finally {
            session.end();
        }
    }

    async analyseObjectAtResolution(onProgress, session) {
        const say = onProgress || (() => {});
        const videoData = this.videoView?.videoData;
        if (!videoData) return null;
        const frame = Math.floor(par.frame);
        const point = {x: this.trackX, y: this.trackY};

        // Do the waiting here rather than handing the user a button that does
        // nothing the first time and works the second.
        if (!cv) {
            cv = getCV();
            if (!cv) {
                say("loading OpenCV");
                try { await loadOpenCV(); cv = getCV(); } catch (e) {
                    console.warn("Analyse Object: OpenCV failed to load", e);
                    return {error: "OpenCV failed to load"};
                }
            }
        }
        if (!this.motionTracker) this.motionTracker = new MotionBackgroundTracker(cv);

        // The background model needs the frames either side of this one, and at
        // the start of a clip — where a user naturally begins — none of them have
        // been decoded. Ask for them and wait, instead of reporting a failure
        // that is really just "not ready yet".
        say("reading frames");
        const first = Sit.aFrame ?? 0;
        const last = Sit.bFrame ?? (Sit.frames - 1);
        const gaps = this.motionGap === 1 ? [1] : [this.motionGap, 1];
        const wanted = new Set([frame]);
        // The gap-1 fallback needs its own neighbors too. Otherwise its result
        // depends on which extra frames happen to remain in the playback cache.
        for (const gap of gaps) for (let k = 1; k <= this.motionSamples; k++) {
            for (const f of [frame - k * gap, frame + k * gap]) {
                if (f >= first && f <= last) wanted.add(f);
            }
        }
        for (const f of wanted) videoData.getImage(f);
        await Promise.all([...wanted]
            .map(f => videoData.waitForFrame(f, 4000).catch(() => false)));
        if (session.cancelled) return {error: 'resolution changed; analyse again'};

        if (videoData.isFrameLoaded && !videoData.isFrameLoaded(frame)) {
            return {error: 'selected frame has not decoded; try again'};
        }

        const image = videoData.getImage(frame);
        if (!image || !image.width) return null;
        const w = image.width || image.videoWidth;
        const origW = videoData.originalVideoWidth || w;
        const scale = w / origW;
        const cx = point.x * scale;
        const cy = point.y * (image.height || image.videoHeight) / (videoData.originalVideoHeight || image.height);

        let best = null;
        const tried = [];
        // A fast pan can move the selected region outside every older sample.
        // Retry with closer samples only if the requested spacing cannot
        // measure the seed; retain the user's spacing when it works.
        for (const gap of gaps) {
            for (const polarity of ['bright', 'dark']) {
                for (const slack of [0, 2]) {
                    for (const featureScale of [1, 2, 4, 8]) {
                        say(`testing ${polarity} scale ${featureScale}`);
                        const hit = this.motionTracker.measure(videoData, frame, cx, cy, {
                            gap,
                            samples: this.motionSamples,
                            // A tight gate: we are asking "how well does the object
                            // right here show up", not "find me something".
                            // Track Radius can include a nearby reticle or another
                            // object. Calibration must stay at the selected point.
                            gate: Math.min(8, Math.max(4, this.trackRadius * scale)),
                            targetRadius: this.trackRadius * scale,
                            featureScale,
                            slack,
                            polarity,
                            mask: this.getMotionMask(),
                            firstFrame: Sit.aFrame ?? 0,
                            lastFrame: Sit.bFrame ?? (Sit.frames - 1),
                        });
                        if (!hit || hit.waiting) continue;
                        tried.push({score: hit.score, polarity, slack, featureScale, gap});
                        if (!best || hit.score > best.score) {
                            best = {score: hit.score, polarity, slack, featureScale, gap};
                        }
                    }
                }
            }
            if (best?.score >= this.motionThreshold) break;
        }
        if (!best) return {error: "nothing measurable here"};
        // A weak best is not a measurement of the object, it is a measurement of
        // noise — and committing settings derived from it is worse than doing
        // nothing, because they look deliberate. Say so and change nothing.
        if (best.score < this.motionThreshold) {
            return {error: `object not clear here (best ${best.score.toFixed(1)} sigma)`};
        }

        this.motionPolarity = best.polarity;
        this.motionSlack = best.slack;
        this.featureSize = best.featureScale;
        this.motionGap = best.gap;
        this.motionFieldCache = null;

        // Report the close runners-up too. This measures ONE frame, and a
        // target's apparent size changes over a long clip — measured on one,
        // Feature Size 2 wins at frame 0 (16.5 vs 12.8 sigma) yet 4 tracks far
        // better over the whole thing. Showing the alternatives lets the user
        // try the other one instead of trusting a single number, which is more
        // honest than a tie-break rule tuned to whichever clip was to hand.
        const alternatives = tried
            .filter(t => t.polarity === best.polarity && t.featureScale !== best.featureScale
                && t.score > best.score * 0.6)
            .sort((a, b) => b.score - a.score)
            .filter((t, i, all) => all.findIndex(v => v.featureScale === t.featureScale) === i)
            .slice(0, 2)
            .map(t => `size ${t.featureScale} at ${t.score.toFixed(0)}`);
        return Object.assign({}, best, {alternatives});
    }

    // Draw the motion field — the current frame with the background's own
    // motion subtracted away. Mid-grey is "explained by the background", bright
    // is "brighter than the background predicts", black is masked out. This is
    // the picture that says whether a target is there to be found at all, which
    // the resulting track never can.
    renderMotionField(ctx) {
        const videoData = this.videoView?.videoData;
        if (!videoData) return;
        if (!this.motionFieldResolutionSession) {
            this.motionFieldResolutionSession = beginVideoAnalysis(videoData, () => {
                this.motionFieldCache = null;
                this.motionTracker?.reset();
            });
        }
        // The field can be switched on before tracking has ever run, which is
        // exactly when it is most useful — so fetch or start the OpenCV load
        // here rather than relying on the tracking path having done it.
        if (!cv) {
            cv = getCV();
            if (!cv) {
                if (!this.motionFieldLoading) {
                    this.motionFieldLoading = true;
                    loadOpenCV().then(() => { cv = getCV(); setRenderOne(true); })
                        .catch(e => console.warn("Motion Field: OpenCV load failed", e));
                }
                return;
            }
        }
        if (!this.motionTracker) this.motionTracker = new MotionBackgroundTracker(cv);

        const frame = Math.floor(par.frame);
        const mask = this.getMotionMask();
        const settingsKey = [videoData.frameCacheGeneration, this.motionGap, this.motionSamples,
            this.motionSlack, this.motionPolarity, Sit.aFrame, Sit.bFrame, mask?.revision].join(':');
        let cached = this.motionFieldCache;
        if (!cached || cached.frame !== frame || cached.settingsKey !== settingsKey) {
            const f = this.motionTracker.field(videoData, frame, {
                gap: this.motionGap,
                samples: this.motionSamples,
                slack: this.motionSlack,
                polarity: this.motionPolarity,
                mask,
                firstFrame: Sit.aFrame ?? 0,
                lastFrame: Sit.bFrame ?? (Sit.frames - 1),
            });
            if (!f) return;
            const canvas = document.createElement('canvas');
            canvas.width = f.width;
            canvas.height = f.height;
            canvas.getContext('2d').putImageData(
                new ImageData(f.data, f.width, f.height), 0, 0);
            cached = this.motionFieldCache = {frame, settingsKey, canvas, f};
        }

        // Blit through the same zoom/pan transform the rest of the overlay uses,
        // so the field stays registered with the video underneath. The field
        // covers the image inset by its border, in decoded-image pixels, so map
        // that rectangle into original-video coords first.
        const img = videoData.getImage(frame);
        const imgW = img?.width || img?.videoWidth || 1;
        const imgH = img?.height || img?.videoHeight || 1;
        const toOrigX = (videoData.originalVideoWidth || imgW) / imgW;
        const toOrigY = (videoData.originalVideoHeight || imgH) / imgH;
        const {f} = cached;
        const [ax, ay] = this.videoView.videoToCanvasCoordsOriginal(
            f.x0 * toOrigX, f.y0 * toOrigY);
        const [bx, by] = this.videoView.videoToCanvasCoordsOriginal(
            (f.x0 + f.width) * toOrigX, (f.y0 + f.height) * toOrigY);
        ctx.drawImage(cached.canvas, ax, ay, bx - ax, by - ay);
    }

    renderThresholdPreview(ctx, width, height) {
        const videoData = this.videoView?.videoData;
        if (!videoData) return;

        const frame = Math.floor(par.frame);
        const image = videoData.getImage(frame);
        if (!image || !image.width) return;

        // Pick the weight rule for whichever centroid method is active.
        // Pixels with weight > 0 light up white (i.e. they'd contribute to the
        // centroid), everything else goes black — so the preview shows exactly
        // the pixel set the algorithm would consider.
        const weightFn = this._currentWeightFn();
        if (!weightFn) return;

        const imgWidth = image.width || image.videoWidth;
        const imgHeight = image.height || image.videoHeight;

        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = imgWidth;
        tempCanvas.height = imgHeight;
        const tempCtx = tempCanvas.getContext('2d');
        tempCtx.drawImage(image, 0, 0, imgWidth, imgHeight);

        const imageData = tempCtx.getImageData(0, 0, imgWidth, imgHeight);
        const data = imageData.data;

        for (let i = 0; i < data.length; i += 4) {
            const on = weightFn(data[i], data[i + 1], data[i + 2]) > 0 ? 255 : 0;
            data[i]     = on;
            data[i + 1] = on;
            data[i + 2] = on;
        }

        tempCtx.putImageData(imageData, 0, 0);

        // Draw the binary mask through the SAME zoom/pan transform the rest of
        // the overlay uses, instead of stretching it across the whole canvas.
        // The mask spans original-video coords 0..origW / 0..origH, so map those
        // corners to canvas space and blit into that rectangle — now it stays
        // registered with the video underneath when the view is zoomed/panned.
        const origW = videoData.originalVideoWidth || imgWidth;
        const origH = videoData.originalVideoHeight || imgHeight;
        const [x0, y0] = this.videoView.videoToCanvasCoordsOriginal(0, 0);
        const [x1, y1] = this.videoView.videoToCanvasCoordsOriginal(origW, origH);
        ctx.drawImage(tempCanvas, x0, y0, x1 - x0, y1 - y0);

        // Overlay the Search/Track radii at the current cursor so the user can
        // see which white (above-threshold) blobs actually fall in range.
        const [cx, cy] = this.videoView.videoToCanvasCoordsOriginal(this.trackX, this.trackY);
        this.drawTrackingCircles(ctx, cx, cy);
    }

    // Live preview of the High/Low Peak detector while the Feature Size slider
    // is being dragged. Scans a window around the current cursor for both
    // local maxima and local minima at the chosen sigma; high peaks render
    // green, low peaks render red. Lets the user pick a sigma where the
    // intended feature shows up cleanly without flooding the frame with noise.
    renderFeatureSizePreview(ctx, width, height) {
        const videoData = this.videoView?.videoData;
        if (!videoData) return;
        const frame = Math.floor(par.frame);
        const image = videoData.getImage(frame);
        if (!image || !image.width) return;

        const imgW = image.width || image.videoWidth;
        const imgH = image.height || image.videoHeight;
        const origW = videoData.originalVideoWidth || imgW;
        const origH = videoData.originalVideoHeight || imgH;

        // Center the preview window on the cursor (in image coords).
        const sx = imgW / origW, sy = imgH / origH;
        const cx = this.trackX * sx;
        const cy = this.trackY * sy;
        // 3× searchRadius window — enough to see candidate features without
        // running peak detection over the whole frame each slider tick.
        const r = (this.searchRadius * sx) * 3;
        const minX = Math.max(0, Math.floor(cx - r));
        const maxX = Math.min(imgW - 1, Math.ceil(cx + r));
        const minY = Math.max(0, Math.floor(cy - r));
        const maxY = Math.min(imgH - 1, Math.ceil(cy + r));
        const roiW = maxX - minX + 1;
        const roiH = maxY - minY + 1;
        if (roiW < 5 || roiH < 5) return;

        const luma = this.extractGrayROI(image, minX, minY, roiW, roiH);
        const sigma = Math.max(0.3, this.featureSize);
        const blurred = sigma > 0.3 ? gaussianBlur1D(luma, roiW, roiH, sigma) : luma;
        const highThresh = this.percentileLuma(luma, 0.95);
        const lowThresh = this.percentileLuma(luma, 0.05);

        // Collect both polarities so the user sees high (green) and low (red)
        // candidates simultaneously while sliding. Each polarity is gated by
        // the same relative-brightness percentile the picker uses, so what
        // you see is what'd actually be selected.
        const draw = (isHigh, color) => {
            const thresh = isHigh ? highThresh : lowThresh;
            ctx.fillStyle = color;
            for (let y = 1; y < roiH - 1; y++) {
                for (let x = 1; x < roiW - 1; x++) {
                    const v = blurred[y * roiW + x];
                    let isPeak = true;
                    for (let dy = -1; dy <= 1 && isPeak; dy++) {
                        for (let dx = -1; dx <= 1 && isPeak; dx++) {
                            if (dx === 0 && dy === 0) continue;
                            const nv = blurred[(y + dy) * roiW + (x + dx)];
                            if (isHigh ? nv >= v : nv <= v) {
                                if (nv === v && (dy < 0 || (dy === 0 && dx < 0))) isPeak = false;
                                else if (nv !== v) isPeak = false;
                            }
                        }
                    }
                    if (!isPeak) continue;

                    // Same relative-brightness gate the picker uses.
                    const orig = luma[y * roiW + x];
                    if (isHigh ? orig < thresh : orig > thresh) continue;

                    const hxx = blurred[y * roiW + (x + 1)] - 2 * v + blurred[y * roiW + (x - 1)];
                    const hyy = blurred[(y + 1) * roiW + x] - 2 * v + blurred[(y - 1) * roiW + x];
                    const hxy = (blurred[(y + 1) * roiW + (x + 1)]
                               - blurred[(y + 1) * roiW + (x - 1)]
                               - blurred[(y - 1) * roiW + (x + 1)]
                               + blurred[(y - 1) * roiW + (x - 1)]) / 4;
                    const det = hxx * hyy - hxy * hxy;
                    const trace = hxx + hyy;
                    if ((isHigh ? trace >= 0 : trace <= 0)) continue;
                    if (det <= 0) continue;
                    if ((trace * trace) / det > 12) continue;

                    // Convert image coords back to original-video coords, then
                    // to canvas. Reusing the existing video→canvas helper keeps
                    // the marker aligned with the actual on-screen feature.
                    const ox = (x + minX) * origW / imgW;
                    const oy = (y + minY) * origH / imgH;
                    const [px, py] = this.videoView.videoToCanvasCoordsOriginal(ox, oy);
                    ctx.beginPath();
                    ctx.arc(px, py, 3, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        };
        draw(true, 'rgba(0, 255, 0, 0.85)');
        draw(false, 'rgba(255, 0, 0, 0.85)');
    }

    // True for every method that actually consults searchRadius, so the GUI /
    // overlay only advertises the Search Radius when it has an effect. (SAM2
    // segments the whole frame and ignores both radii.)
    methodUsesSearchRadius() {
        switch (this.trackingMethod) {
            case 'motion':
            case 'centerOnBright':
            case 'centerOnDark':
            case 'centerOnColor':
            case 'highPeak':
            case 'lowPeak':
            case 'template':
            case 'opticalflow':
                return true;
            default:
                return false;
        }
    }

    // Draw the Search Radius (dashed, outer "catch" range) and Track Radius
    // (solid, inner feature/centroid disk) plus crosshair at a canvas point.
    // Shared by the live overlay and the threshold preview so both radii are
    // always visible and the user can see how a bright blob relates to each.
    // Returns the canvas-space Track Radius (callers reuse it for labels etc.).
    drawTrackingCircles(ctx, cx, cy) {
        const {dWidth} = this.videoView;
        const refW = this.videoView.originalVideoWidth || this.videoView.videoWidth || 1;
        const scale = dWidth / refW;
        const missing = !this.trackedPositions.has(Math.floor(par.frame)) &&
            this.trackedPositions.unmeasuredFrames?.has(Math.floor(par.frame));
        const trackColor = missing ? '#aaaaaa' : this.tracking ? '#00ff00' : '#ffff00';
        const dimColor = missing ? 'rgba(170, 170, 170, 0.5)' :
            this.tracking ? 'rgba(0, 255, 0, 0.5)' : 'rgba(255, 255, 0, 0.5)';

        // Search Radius — only drawn for methods that use it.
        if (this.methodUsesSearchRadius()) {
            ctx.strokeStyle = dimColor;
            ctx.lineWidth = 1;
            ctx.setLineDash([6, 6]);
            ctx.beginPath();
            ctx.arc(cx, cy, this.searchRadius * scale, 0, Math.PI * 2);
            ctx.stroke();
            ctx.setLineDash([]);
        }

        // Track Radius — solid circle + crosshair.
        const canvasRadius = this.trackRadius * scale;
        ctx.strokeStyle = trackColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, canvasRadius, 0, Math.PI * 2);
        ctx.stroke();

        ctx.strokeStyle = dimColor;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - canvasRadius - 5, cy);
        ctx.lineTo(cx + canvasRadius + 5, cy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx, cy - canvasRadius - 5);
        ctx.lineTo(cx, cy + canvasRadius + 5);
        ctx.stroke();

        return canvasRadius;
    }

    renderOverlay(frame) {
        if (!this.enabled || !this.overlay) return;

        const width = this.videoView.widthPx;
        const height = this.videoView.heightPx;

        if (this.overlay.width !== width || this.overlay.height !== height) {
            this.overlay.width = width;
            this.overlay.height = height;
        }

        const ctx = this.overlayCtx;
        ctx.clearRect(0, 0, width, height);
        
        if (this.thresholdPreview) {
            this.renderThresholdPreview(ctx, width, height);
            return;
        }

        if (this.showMotionField && this.trackingMethod === 'motion') {
            this.renderMotionField(ctx);
            // fall through so the cursor still draws on top of the field
        }

        if (this.featureSizePreview) {
            this.renderFeatureSizePreview(ctx, width, height);
            // fall through so the cursor and existing-keyframe markers still draw
        }

        // Check if video dimensions have changed (e.g., new video loaded)
        const videoDims = this.getImageDimensions();
        if (videoDims.width !== this.lastVideoWidth || videoDims.height !== this.lastVideoHeight) {
            // Video dimensions changed - recenter cursor
            if (videoDims.width > 0 && videoDims.height > 0) {
                this.trackX = videoDims.width / 2;
                this.trackY = videoDims.height / 2;
                this.lastVideoWidth = videoDims.width;
                this.lastVideoHeight = videoDims.height;
                // Clear any old tracking data since it's for a different video
                // Must clear even during active tracking — old positions are for wrong video
                if (this.tracking) {
                    this.stopTracking();
                }
                this.trackedPositions.clear();
                this.trackedPositions.set(Math.floor(par.frame), {x: this.trackX, y: this.trackY});
            }
        }

        if (this.tracking) {
            this.trackFrame(frame);
        } else {
            const f = Math.floor(frame);
            const pos = this.getInterpolatedPosition(f);
            if (pos) {
                this.trackX = pos.x;
                this.trackY = pos.y;
            }
        }

        const videoData = this.videoView?.videoData;
        const stabEnabled = videoData?.stabilizationEnabled && videoData?.stabilizationData && videoData?.stabilizationReferencePoint;

        // Intentionally hide tracking cursor after stabilization is applied,
        // since the overlay would be misaligned with the stabilized video.
        if (stabEnabled) return;
        
        const getStabOffset = (f) => {
            if (!stabEnabled) return {x: 0, y: 0};
            const trackPos = videoData.stabilizationData.get(Math.floor(f));
            if (!trackPos) return {x: 0, y: 0};
            if (videoData.stabilizationDirectOffset) {
                return {x: trackPos.x, y: trackPos.y};
            }
            return {
                x: videoData.stabilizationReferencePoint.x - trackPos.x,
                y: videoData.stabilizationReferencePoint.y - trackPos.y
            };
        };

        const stabOffset = getStabOffset(frame);
        const [cx, cy] = this.videoView.videoToCanvasCoordsOriginal(this.trackX + stabOffset.x, this.trackY + stabOffset.y);

        const pointFrame = Math.floor(frame);
        const unavailable = !this.trackedPositions.has(pointFrame) &&
            this.trackedPositions.unmeasuredFrames?.has(pointFrame);
        const estimated = this.trackedPositions.get(pointFrame)?.estimated;
        const canvasRadius = this.drawTrackingCircles(ctx, cx, cy);

        ctx.font = '12px monospace';
        ctx.fillStyle = unavailable || estimated ? '#ffb347' : this.tracking ? '#00ff00' : '#ffff00';
        // The frame number rather than a state word: which frame you are looking
        // at is what you actually need when reading a track back, and the colour
        // already says whether tracking is running.
        ctx.fillText(unavailable ? `${pointFrame}: target not found; drag marker to re-seed` :
            `${pointFrame} (${Math.round(this.trackX)}, ${Math.round(this.trackY)})${estimated ? ' estimated' : ''}`,
            unavailable ? 12 : cx + canvasRadius + 10, unavailable ? 24 : cy);
        if (this.tracking && this.trackingMethod === 'motion') {
            const background = this.motionRegime.state === 'unknown'
                ? 'registration unavailable' : this.motionRegime.state;
            ctx.fillText(`Background: ${background}`, 12, unavailable ? 42 : 24);
        }
        
        // Edit Head Only fades back everything a drag can no longer reach, so
        // what stays bright is exactly what is still editable.
        if (this.trackedPositions.size > 1) {
            ctx.strokeStyle = this.editHeadOnly
                ? 'rgba(0, 255, 255, 0.25)' : 'rgba(0, 255, 255, 0.5)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            let started = false;
            let previousFrame = null;
            
            const outputPositions = this.getOutputPositions();
            const sortedFrames = Array.from(outputPositions.keys()).sort((a, b) => a - b);
            for (const f of sortedFrames) {
                const pos = outputPositions.get(f);
                const offset = getStabOffset(f);
                const [px, py] = this.videoView.videoToCanvasCoordsOriginal(pos.x + offset.x, pos.y + offset.y);
                if (!started || (f > previousFrame + 1 && outputPositions.unmeasuredFrames?.has(previousFrame + 1))) {
                    ctx.moveTo(px, py);
                    started = true;
                } else {
                    ctx.lineTo(px, py);
                }
                previousFrame = f;
            }
            ctx.stroke();
        }

        const keyframeRadius = canvasRadius * 0.3;
        // Show only the N keyframes nearest to the current frame
        let keyframesToDraw = Array.from(this.manualKeyframes);
        if (this.showMaxKeyframes < keyframesToDraw.length) {
            keyframesToDraw.sort((a, b) => Math.abs(a - frame) - Math.abs(b - frame));
            keyframesToDraw = keyframesToDraw.slice(0, this.showMaxKeyframes);
        }
        const headFrame = Math.floor(frame);
        for (const f of keyframesToDraw) {
            const pos = this.trackedPositions.get(f);
            if (pos) {
                const offset = getStabOffset(f);
                const [kx, ky] = this.videoView.videoToCanvasCoordsOriginal(pos.x + offset.x, pos.y + offset.y);
                // The keyframe at the current frame sits under the yellow cursor
                // and IS the head, so it keeps full opacity; the others recede.
                ctx.strokeStyle = (this.editHeadOnly && f !== headFrame)
                    ? 'rgba(255, 0, 255, 0.1)' : '#ff00ff';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.arc(kx, ky, keyframeRadius, 0, Math.PI * 2);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(kx - keyframeRadius - 3, ky);
                ctx.lineTo(kx + keyframeRadius + 3, ky);
                ctx.stroke();
                ctx.beginPath();
                ctx.moveTo(kx, ky - keyframeRadius - 3);
                ctx.lineTo(kx, ky + keyframeRadius + 3);
                ctx.stroke();
            }
        }
    }
    
    clearTrack() {
        this.trackedPositions.clear();
        this.manualKeyframes.clear();
        if (this.motionTracker) this.motionTracker.reset();
        this.motionMisses = 0;
        this.motionOffscreen = false;
        this.motionLastFrame = null;
        this.motionAnchors = [];
        this.motionCandidate = null;
        this.motionScores = [];
        this.motionTrail = [];
        // Recenter the cursor to the middle of the (original-coords) video so
        // a freshly-cleared track has a sane seed point. The current frame
        // gets that center as its sole keyframe.
        const {width, height} = this.getImageDimensions();
        this.trackX = width / 2;
        this.trackY = height / 2;
        const frame = Math.floor(par.frame);
        this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
        this.updateSliderStatus();
        
        const videoData = this.videoView?.videoData;
        if (videoData) {
            videoData.setStabilizationEnabled(false);
            videoData.stabilizationData = null;
            videoData.stabilizationReferencePoint = null;
        }
        
        setRenderOne(true);
    }

    clearFromHere() {
        const currentFrame = Math.floor(par.frame);
        const bFrame = Sit.bFrame ?? (Sit.frames - 1);
        for (const f of this.trackedPositions.keys()) {
            if (f >= currentFrame && f <= bFrame) {
                this.trackedPositions.delete(f);
                this.manualKeyframes.delete(f);
            }
        }
        for (const f of this.trackedPositions.unmeasuredFrames || []) {
            if (f >= currentFrame && f <= bFrame) this.trackedPositions.unmeasuredFrames.delete(f);
        }
        this.updateSliderStatus();
        setRenderOne(true);
    }

    get trackedPositions() { return this._trackedPositions; }
    set trackedPositions(positions) {
        this._trackedPositions = positions instanceof TrackPositionMap ? positions : new TrackPositionMap(positions);
        if (positions?.unmeasuredFrames) this._trackedPositions.unmeasuredFrames = new Set(positions.unmeasuredFrames);
        this._smoothedCache = null;
    }

    getOutputPositions() {
        const n = normalizeTrackSmoothing(this.smoothingFrames);
        if (!n) return this.trackedPositions;
        const key = `${this.trackedPositions.revision}:${n}:${Array.from(this.manualKeyframes).join(',')}`;
        if (this._smoothedCache?.key !== key) {
            this._smoothedCache = {key, positions: smoothPointTrack(this.trackedPositions, this.manualKeyframes, n)};
        }
        return this._smoothedCache.positions;
    }

    getRawInterpolatedPosition(frame) {
        return interpolatePosition(this.trackedPositions, frame);
    }

    getInterpolatedPosition(frame) {
        return interpolatePosition(this.getOutputPositions(), frame);
    }

    setSmoothingFrames(frames) {
        this.smoothingFrames = normalizeTrackSmoothing(frames);
        this.refreshSmoothedOutput();
    }

    refreshSmoothedOutput() {
        const vd = this.videoView?.videoData;
        if (vd?.stabilizationEnabled && !vd.stabilizationDirectOffset && this.trackedPositions.size) {
            const points = this.getOutputPositions();
            const first = Math.min(...points.keys());
            vd.setStabilizationData(points, points.get(first));
        }
        NodeMan.get('autoTrackLOS', false)?.recalculateCascade();
        setRenderOne(true);
    }
    
    // 1 = a point the tracker worked out, 2 = a point a person placed. The
    // slider draws each value in its own colour, so the user points a track
    // depends on are visible at a glance along the timeline.
    getCacheStatusArray() {
        const status = new Array(Sit.frames).fill(0);
        for (const [f, point] of this.trackedPositions) {
            if (f >= 0 && f < Sit.frames) status[f] = point.estimated ? 3 : 1;
        }
        for (const f of this.manualKeyframes) {
            if (f >= 0 && f < Sit.frames) status[f] = 2;
        }
        return status;
    }

    // Points a person placed. These are evidence, not estimates: the tracker
    // never overwrites one, and uses them to re-seed itself.
    isUserPoint(frame) {
        return this.manualKeyframes.has(Math.floor(frame));
    }

    clearUserPoints() {
        for (const f of Array.from(this.manualKeyframes)) this.trackedPositions.delete(f);
        this.manualKeyframes.clear();
        this.updateSliderStatus();
        setRenderOne(true);
    }

    clearAutoPoints() {
        for (const f of Array.from(this.trackedPositions.keys())) {
            if (!this.manualKeyframes.has(f)) this.trackedPositions.delete(f);
        }
        this.trackedPositions.unmeasuredFrames?.clear();
        if (this.motionTracker) this.motionTracker.reset();
        this.motionAnchors = [];
        this.motionCandidate = null;
        this.motionTrail = [];
        this.motionScores = [];
        this.motionMisses = 0;
        this.motionOffscreen = false;
        this.motionLastFrame = null;
        this.updateSliderStatus();
        setRenderOne(true);
    }
    
    updateSliderStatus() {
        const slider = NodeMan.get("FrameSlider", false);
        if (slider) {
            slider.setStatusOverlay(this.getCacheStatusArray(), 2);
        }
    }
    
    clearSliderStatus() {
        const slider = NodeMan.get("FrameSlider", false);
        if (slider) {
            slider.clearStatusOverlay();
        }
    }
}

let objectTracker = null;
let trackingFolder = null;
let enableMenuItem = null;
let startMenuItem = null;
let analyseMenuItem = null;
let renderHooked = false;

export function resetObjectTracking() {
    if (objectTracker) {
        // Clear video stabilization
        const videoView = objectTracker.videoView;
        const videoData = videoView?.videoData;
        if (videoData) {
            videoData.setStabilizationEnabled(false);
            videoData.stabilizationData = null;
            videoData.stabilizationReferencePoint = null;
        }

        objectTracker.disable();
        // Every cv.Mat the motion tracker holds lives in the OpenCV heap and is
        // freed only by hand, so dropping the reference alone leaks the whole
        // cache on every sitch or video reload.
        if (objectTracker.motionTracker) {
            objectTracker.motionTracker.dispose();
            objectTracker.motionTracker = null;
        }
        objectTracker = null;
    }
    renderHooked = false;
    if (enableMenuItem) {
        enableMenuItem.name(t("tracking.enable.label"));
    }
    if (startMenuItem) {
        startMenuItem.name(t("tracking.start.label"));
    }
    if (stabilizeToggleMenuItem) {
        stabilizeToggleMenuItem.name(t("tracking.stabilizeToggle.enableLabel"));
    }
}

function toggleEnableTracking() {
    const videoView = NodeMan.get("video", false);
    if (!videoView) {
        alert("No video view found");
        return;
    }

    if (objectTracker && objectTracker.enabled) {
        objectTracker.disable();
        if (enableMenuItem) enableMenuItem.name(t("tracking.enable.label"));
        if (startMenuItem) startMenuItem.name(t("tracking.start.label"));
        if (trackingFolder) trackingFolder.close();
        setRenderOne(true);
        return;
    }
    
    if (!objectTracker) {
        objectTracker = new ObjectTracker(videoView);
        applyPendingTrackingSettings(objectTracker);
        // Local-only debug hook so MCP / console can reach the module-scoped
        // tracker (mirrors the tools-page window.shf pattern). Never exposed in
        // production builds.
        if (isLocal) window._objectTracker = objectTracker;
    }
    
    objectTracker.enable();
    if (enableMenuItem) enableMenuItem.name(t("tracking.enable.disableLabel"));
    
    if (!renderHooked) {
        renderHooked = true;
        const originalRender = videoView.renderCanvas.bind(videoView);
        videoView.renderCanvas = function(frame) {
            originalRender(frame);
            if (objectTracker && objectTracker.enabled) {
                objectTracker.renderOverlay(frame);
            }
        };
    }
    
    setRenderOne(true);
}

function toggleStartTracking() {
    if (!objectTracker || !objectTracker.enabled) {
        toggleEnableTracking();
        if (!objectTracker || !objectTracker.enabled) {
            return;
        }
    }
    
    if (objectTracker.tracking) {
        objectTracker.stopTracking();
        if (startMenuItem) startMenuItem.name(t("tracking.start.label"));
        setRenderOne(true);
        return;
    }

    // Pure-JS methods don't need external libraries
    const noLibMethods = ['centerOnBright', 'centerOnDark', 'centerOnColor', 'highPeak', 'lowPeak'];
    if (noLibMethods.includes(objectTracker.trackingMethod)) {
        objectTracker.startTracking();
        if (startMenuItem) startMenuItem.name(t("tracking.start.stopLabel"));
        setRenderOne(true);
        return;
    }

    // SAM2 mode: send video + click to server, get back all positions
    if (objectTracker.trackingMethod === 'sam2') {
        runSAM2Tracking();
        return;
    }

    // Optical flow mode requires jsfeat
    if (objectTracker.trackingMethod === 'opticalflow') {
        const jsfeat = getJsfeat();
        if (jsfeat) {
            objectTracker.startTracking();
            if (startMenuItem) startMenuItem.name(t("tracking.start.stopLabel"));
            setRenderOne(true);
            return;
        }

        if (startMenuItem) startMenuItem.name(t("tracking.status.loadingJsfeat"));

        loadJsfeat().then(() => {
            objectTracker.startTracking();
            if (startMenuItem) startMenuItem.name(t("tracking.start.stopLabel"));
            setRenderOne(true);
        }).catch(e => {
            console.error("Failed to load jsfeat:", e);
            alert("Failed to load jsfeat.js: " + e.message);
            if (startMenuItem) startMenuItem.name(t("tracking.start.label"));
        });
        return;
    }

    // Template matching mode requires OpenCV
    if (cv) {
        objectTracker.startTracking();
        if (startMenuItem) startMenuItem.name(t("tracking.start.stopLabel"));
        setRenderOne(true);
        return;
    }

    if (startMenuItem) startMenuItem.name(t("tracking.status.loadingOpenCv"));

    loadOpenCV().then(() => {
        cv = getCV();
        objectTracker.startTracking();
        if (startMenuItem) startMenuItem.name(t("tracking.start.stopLabel"));
        setRenderOne(true);
    }).catch(e => {
        console.error("Failed to load OpenCV:", e);
        alert("Failed to load OpenCV.js: " + e.message);
        if (startMenuItem) startMenuItem.name(t("tracking.start.label"));
    });
}

async function runSAM2Tracking() {
    const videoView = objectTracker.videoView;
    const videoData = videoView?.videoData;

    if (!videoData) {
        alert("No video loaded.");
        return;
    }

    // Get the video file data (ArrayBuffer stored from file load or drop)
    const videoBuffer = videoData.videoDroppedData;
    if (!videoBuffer) {
        alert("SAM2 tracking requires a loaded video file (drag-and-drop or file picker). URL-only videos are not yet supported.");
        return;
    }

    const clickX = objectTracker.trackX;
    const clickY = objectTracker.trackY;
    const clickFrame = Math.floor(par.frame);

    if (startMenuItem) startMenuItem.name(t("tracking.status.sam2Connecting"));
    setRenderOne(true);

    try {
        // SAM2 service is proxied through the web server at /sam2/
        const sam2Base = '/sam2';
        const healthResp = await fetch(`${sam2Base}/health`).catch(() => null);
        if (!healthResp || !healthResp.ok) {
            alert("SAM2 service is not running.\n\nStart it with:\n  cd sam2-service && ./start.sh\n\nMake sure your web server proxies /sam2/ to port 8001.");
            if (startMenuItem) startMenuItem.name(t("tracking.start.label"));
            return;
        }

        // Upload video and start tracking job
        if (startMenuItem) startMenuItem.name(t("tracking.status.sam2Uploading"));
        setRenderOne(true);
        await new Promise(resolve => setTimeout(resolve, 0));

        const formData = new FormData();
        const blob = new Blob([videoBuffer], { type: 'video/mp4' });
        formData.append('video', blob, 'video.mp4');
        formData.append('x', clickX.toString());
        formData.append('y', clickY.toString());
        formData.append('frame', clickFrame.toString());

        const startResp = await fetch(`${sam2Base}/track`, {
            method: 'POST',
            body: formData,
        });

        if (!startResp.ok) {
            const errText = await startResp.text();
            throw new Error(`SAM2 service error (${startResp.status}): ${errText}`);
        }

        const { job_id } = await startResp.json();
        console.log(`[SAM2] Job started: ${job_id}`);

        // Poll for progress
        let results = null;
        while (true) {
            await new Promise(resolve => setTimeout(resolve, 1000));

            const pollResp = await fetch(`${sam2Base}/track/${job_id}`);
            if (!pollResp.ok) {
                throw new Error(`SAM2 poll error (${pollResp.status})`);
            }

            const job = await pollResp.json();

            if (job.status === 'error') {
                throw new Error(job.error || 'SAM2 tracking failed');
            }

            // Update status display with progress
            if (job.total > 0 && job.progress > 0) {
                const pct = Math.round(100 * job.progress / job.total);
                if (startMenuItem) startMenuItem.name(`SAM2: ${job.phase} ${pct}%`);
            } else {
                if (startMenuItem) startMenuItem.name(`SAM2: ${job.phase}...`);
            }
            setRenderOne(true);

            if (job.status === 'complete') {
                results = job.results;
                break;
            }
        }

        // Store the initial click position
        objectTracker.trackedPositions.set(clickFrame, { x: clickX, y: clickY });

        // Populate tracked positions from SAM2 results
        let validCount = 0;
        let lostCount = 0;
        for (const r of results) {
            if (r.cx >= 0 && r.cy >= 0) {
                objectTracker.trackedPositions.set(r.frame, { x: r.cx, y: r.cy });
                validCount++;
            } else {
                lostCount++;
            }
        }

        console.log(`[SAM2] Got ${results.length} frames: ${validCount} valid, ${lostCount} lost. trackedPositions size: ${objectTracker.trackedPositions.size}`);
        if (results.length > 0) {
            console.log(`[SAM2] Frame range: ${results[0].frame} - ${results[results.length - 1].frame}`);
            console.log(`[SAM2] First result:`, results[0], `Last:`, results[results.length - 1]);
        }

        if (startMenuItem) startMenuItem.name(t("tracking.start.label"));
        objectTracker.updateSliderStatus();
        setRenderOne(true);

    } catch (e) {
        console.error("[SAM2] Tracking failed:", e);
        alert("SAM2 tracking failed: " + e.message);
        if (startMenuItem) startMenuItem.name(t("tracking.start.label"));
    }
}

function clearTrack() {
    if (objectTracker) {
        objectTracker.clearTrack();
        if (stabilizeToggleMenuItem) {
            stabilizeToggleMenuItem.name(t("tracking.stabilizeToggle.enableLabel"));
        }
    }
}

function clearFromHere() {
    if (objectTracker) {
        objectTracker.clearFromHere();
    }
}

function stabilizeVideo() {
    if (!objectTracker || !objectTracker.enabled) {
        alert("Please enable tracking first and track an object before stabilizing.");
        return;
    }

    if (objectTracker.trackedPositions.size === 0) {
        alert("No tracking data available. Please track an object first.");
        return;
    }

    const videoView = objectTracker.videoView;
    const videoData = videoView?.videoData;

    if (!videoData) {
        alert("No video data available.");
        return;
    }

    // Use the first tracked frame as the reference point
    const outputPositions = objectTracker.getOutputPositions();
    const firstFrame = Math.min(...outputPositions.keys());
    const referencePoint = outputPositions.get(firstFrame);

    if (!referencePoint) {
        alert("Could not determine reference point.");
        return;
    }

    // Pass tracking data to video system
    videoData.setStabilizationData(outputPositions, referencePoint);
    videoData.setStabilizationEnabled(true);

    if (stabilizeToggleMenuItem) {
        stabilizeToggleMenuItem.name(t("tracking.stabilizeToggle.disableLabel"));
    }

    setRenderOne(true);
}

function toggleStabilization() {
    if (!objectTracker || !objectTracker.enabled) {
        return;
    }

    const videoView = objectTracker.videoView;
    const videoData = videoView?.videoData;

    if (!videoData || !videoData.stabilizationData) {
        alert("No stabilization data available. Use 'Stabilize' first.");
        return;
    }

    const newState = !videoData.stabilizationEnabled;
    videoData.setStabilizationEnabled(newState);

    if (stabilizeToggleMenuItem) {
        stabilizeToggleMenuItem.name(newState ? "Disable Stabilization" : "Enable Stabilization");
    }

    setRenderOne(true);
}

// Calculate the stabilization offset bounds across all frames
export function pointTrackingShift(videoData, point, reference, width = videoData.videoWidth, height = videoData.videoHeight) {
    if (!point || !reference) return {x: 0, y: 0};
    const sx = width / (videoData.originalVideoWidth || width);
    const sy = height / (videoData.originalVideoHeight || height);
    return videoData.stabilizeCenters
        ? {x: width / 2 - point.x * sx, y: height / 2 - point.y * sy}
        : {x: (reference.x - point.x) * sx, y: (reference.y - point.y) * sy};
}

function getStabilizationBounds() {
    if (!objectTracker || !objectTracker.trackedPositions || objectTracker.trackedPositions.size === 0) {
        return null;
    }

    const videoView = objectTracker.videoView;
    const videoData = videoView?.videoData;
    if (!videoData) return null;

    const outputPositions = objectTracker.getOutputPositions();
    const firstFrame = Math.min(...outputPositions.keys());
    const referencePoint = outputPositions.get(firstFrame);
    if (!referencePoint) return null;

    let minX = 0, maxX = 0, minY = 0, maxY = 0;

    for (const pos of outputPositions.values()) {
        const {x: shiftX, y: shiftY} = pointTrackingShift(videoData, pos, referencePoint);
        minX = Math.min(minX, shiftX);
        maxX = Math.max(maxX, shiftX);
        minY = Math.min(minY, shiftY);
        maxY = Math.max(maxY, shiftY);
    }

    return { minX, maxX, minY, maxY };
}

// Controls whether the "Render Stabilized Video" exports include the
// Video Info Display readouts (frame counters, timestamps, etc.) and the
// OSD Tracker data series. Toggled from the Auto Tracking menu.
let includeVideoInfoOnExport = false;

async function renderStabilizedVideo(expanded = false) {
    if (!objectTracker || !objectTracker.enabled) {
        alert("Please enable tracking first and track an object before rendering.");
        return;
    }

    if (objectTracker.trackedPositions.size === 0) {
        alert("No tracking data available. Please track an object first.");
        return;
    }

    const videoView = objectTracker.videoView;
    const videoData = videoView?.videoData;

    if (!videoData) {
        alert("No video data available.");
        return;
    }

    const startFrame = Sit.aFrame;
    const endFrame = Sit.bFrame;
    const totalFrames = endFrame - startFrame + 1;
    const fps = Sit.fps;

    // Get video dimensions
    let width = videoData.videoWidth;
    let height = videoData.videoHeight;
    let offsetX = 0;
    let offsetY = 0;

    // For expanded mode, calculate extra canvas size needed
    if (expanded) {
        const bounds = getStabilizationBounds();
        if (bounds) {
            // Expand canvas to fit all shifts
            const extraLeft = Math.ceil(Math.abs(Math.min(0, bounds.minX)));
            const extraRight = Math.ceil(Math.max(0, bounds.maxX));
            const extraTop = Math.ceil(Math.abs(Math.min(0, bounds.minY)));
            const extraBottom = Math.ceil(Math.max(0, bounds.maxY));

            width += extraLeft + extraRight;
            height += extraTop + extraBottom;
            offsetX = extraLeft;
            offsetY = extraTop;
        }
    }

    const bestFormat = await getBestFormatForResolution(DefaultVideoFormat, width, height);
    if (!bestFormat.formatId) {
        alert(`Video export failed: ${bestFormat.reason}`);
        return;
    }

    const formatId = bestFormat.formatId;
    const extension = getVideoExtension(formatId);
    const modeLabel = expanded ? "expanded" : "original size";

    console.log(`Starting stabilized video export (${modeLabel}, ${formatId}): ${totalFrames} frames at ${fps} fps, ${width}x${height}`);

    const savedFrame = par.frame;
    const savedPaused = par.paused;
    const savedStabilizationEnabled = videoData.stabilizationEnabled;
    videoData.stabilizationEnabled = false;  // Disable during export to prevent stabilizedImageCache growth
    par.paused = true;

    const progress = new ExportProgressWidget(`Exporting stabilized video (${modeLabel})...`, totalFrames);

    const videoStartDate = GlobalDateTimeNode ? GlobalDateTimeNode.frameToDate(startFrame) : null;

    // Get reference point for stabilization
    const outputPositions = objectTracker.getOutputPositions();
    const firstFrame = Math.min(...outputPositions.keys());
    const referencePoint = outputPositions.get(firstFrame);

    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = width;
    compositeCanvas.height = height;
    const compositeCtx = compositeCanvas.getContext('2d');

    try {
        const exporter = await createVideoExporter(formatId, {
            width,
            height,
            fps,
            bitrate: 5_000_000,
            keyFrameInterval: 30,
            videoStartDate,
            hardwareAcceleration: bestFormat.hardwareAcceleration,
        });

        await exporter.initialize();

        for (let i = 0; i < totalFrames; i++) {
            if (progress.shouldStop()) break;

            const frame = startFrame + i;
            par.frame = frame;

            // Wait for video frame
            videoData.getImage(frame);
            if (!await videoData.waitForFrame(frame)) continue;

            const originalImage = videoData.getImage(frame);
            if (!originalImage || !originalImage.width) continue;

            // Calculate stabilization shift for this frame
            // Must match the logic in CVideoData.getStabilizedImage()
            const trackPos = interpolatePosition(outputPositions, frame);
            const {x: shiftX, y: shiftY} = pointTrackingShift(videoData, trackPos, referencePoint,
                originalImage.width, originalImage.height);

            // Clear and draw stabilized frame
            compositeCtx.fillStyle = 'black';
            compositeCtx.fillRect(0, 0, width, height);
            compositeCtx.drawImage(originalImage, offsetX + shiftX, offsetY + shiftY);

            drawVideoWatermark(compositeCtx, width);
            drawAttributionOnCanvas(compositeCtx, width, height);

            if (includeVideoInfoOnExport) {
                // Reuse the live Video Info Display draw path so anything
                // enabled in the Video Info Display menu (frame counter,
                // timecode, dates) AND any visible OSD Tracker data series
                // is composited into the export at native resolution.
                const videoInfo = NodeMan.get("videoInfo", false);
                if (videoInfo && typeof videoInfo.drawInfoToContext === "function") {
                    videoInfo.drawInfoToContext(
                        compositeCtx, width, height,
                        { x: 0, y: 0, w: width, h: height },
                        frame
                    );
                }
            }

            await exporter.addFrame(compositeCanvas, i);

            if (i % 10 === 0) {
                progress.update(i + 1);
                await new Promise(r => setTimeout(r, 0));
            }
        }

        if (progress.shouldSave()) {
            const blob = await exporter.finalize(
                (current, total) => progress.setFinalizeProgress(current, total),
                (status) => progress.setStatus(status)
            );

            const filename = `${getExportPrefix()}_stabilized_${expanded ? 'expanded_' : ''}${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${extension}`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);

            console.log(`Stabilized video export complete: ${filename}`);
        } else {
            console.log('Stabilized video export aborted by user');
        }

    } catch (e) {
        console.error('Export failed:', e);
        alert('Video export failed: ' + e.message);
    } finally {
        progress.remove();
        par.frame = savedFrame;
        par.paused = savedPaused;
        videoData.stabilizationEnabled = savedStabilizationEnabled;
        setRenderOne(true);
    }
}

let radiusController = null;
let stabilizeToggleMenuItem = null;

export function addObjectTrackingMenu() {
    if (!guiMenus.view) return;

    trackingFolder = guiMenus.video.addFolder("Point Track").close().perm();
    addVideoAnalysisResolutionMenu(trackingFolder, () => NodeMan.get('video', false)?.videoData);
    const smoothing = {
        get smoothingFrames() { return objectTracker?.smoothingFrames ?? pendingTrackingSettings.smoothingFrames; },
        set smoothingFrames(v) {
            pendingTrackingSettings.smoothingFrames = normalizeTrackSmoothing(v);
            objectTracker?.setSmoothingFrames(v);
        },
    };
    trackingFolder.add(smoothing, 'smoothingFrames', {
        'Off': 0, '2 frames': 2, '3 frames': 3, '4 frames': 4, '5 frames': 5,
        '6 frames': 6, '7 frames': 7, '8 frames': 8, '9 frames': 9, '10 frames': 10,
    }).name('Output Smoothing').listen().perm()
        .tooltip('Centered average of the output track. Smooths the trail, graphs, line of sight and stabilization. Raw measurements and user points are preserved. Try 3–5 frames for jumps between parts of an object.');

    const menuActions = {
        enableTracking: toggleEnableTracking,
        startTracking: toggleStartTracking,
        clearFromHere: clearFromHere,
        clearTrack: clearTrack,
        stabilizeVideo: stabilizeVideo,
        toggleStabilization: toggleStabilization,
        renderStabilized: () => renderStabilizedVideo(false),
        renderStabilizedExpanded: () => renderStabilizedVideo(true),
    };

    enableMenuItem = trackingFolder.add(menuActions, 'enableTracking')
        .name(t("tracking.enable.label"))
        .tooltip(t("tracking.enable.tooltip"))
        .perm();

    startMenuItem = trackingFolder.add(menuActions, 'startTracking')
        .name(t("tracking.start.label"))
        .tooltip(t("tracking.start.tooltip"))
        .perm();

    trackingFolder.add(menuActions, 'clearFromHere')
        .name(t("tracking.clearFromHere.label"))
        .tooltip(t("tracking.clearFromHere.tooltip"))
        .perm();

    // Two separate actions, because the two kinds of point are not equivalent:
    // auto points can always be recomputed, the points a person placed cannot.
    // Only the destructive one asks.
    const clearActions = {
        async clearUserPoints() {
            if (!objectTracker) return;
            const count = objectTracker.manualKeyframes.size;
            if (count === 0) return;
            const ok = await showConfirm(
                `Delete the ${count} point${count === 1 ? "" : "s"} you placed by hand? `
                + "The automatically tracked points are not affected, and cannot replace "
                + "these — they are what the tracker uses to correct itself.",
                {title: "Clear User Points", yesLabel: "Delete", noLabel: "Keep"});
            if (ok) objectTracker.clearUserPoints();
        },
        clearAutoPoints() {
            if (objectTracker) objectTracker.clearAutoPoints();
        },
    };

    trackingFolder.add(clearActions, 'clearUserPoints')
        .name(t("tracking.clearUserPoints.label"))
        .tooltip(t("tracking.clearUserPoints.tooltip"))
        .perm();

    trackingFolder.add(clearActions, 'clearAutoPoints')
        .name(t("tracking.clearAutoPoints.label"))
        .tooltip(t("tracking.clearAutoPoints.tooltip"))
        .perm();

    trackingFolder.add(menuActions, 'stabilizeVideo')
        .name(t("tracking.stabilize.label"))
        .tooltip(t("tracking.stabilize.tooltip"))
        .perm();

    stabilizeToggleMenuItem = trackingFolder.add(menuActions, 'toggleStabilization')
        .name(t("tracking.stabilizeToggle.enableLabel"))
        .tooltip(t("tracking.stabilizeToggle.tooltip"))
        .perm();

    const stabilizeCentersParams = {
        get stabilizeCenters() {
            const videoData = objectTracker?.videoView?.videoData;
            return videoData?.stabilizeCenters ?? true;
        },
        set stabilizeCenters(v) {
            const videoData = objectTracker?.videoView?.videoData;
            if (videoData) {
                videoData.stabilizeCenters = v;
                videoData.stabilizedImageCache = [];
                setRenderOne(true);
            }
        }
    };

    trackingFolder.add(stabilizeCentersParams, 'stabilizeCenters')
        .name(t("tracking.stabilizeCenters.label"))
        .tooltip(t("tracking.stabilizeCenters.tooltip"))
        .listen()
        .perm();

    trackingFolder.add(menuActions, 'renderStabilized')
        .name(t("tracking.renderStabilized.label"))
        .tooltip(t("tracking.renderStabilized.tooltip"))
        .perm();

    trackingFolder.add(menuActions, 'renderStabilizedExpanded')
        .name(t("tracking.renderStabilizedExpanded.label"))
        .tooltip(t("tracking.renderStabilizedExpanded.tooltip"))
        .perm();

    const includeInfoParams = {
        get includeVideoInfo() { return includeVideoInfoOnExport; },
        set includeVideoInfo(v) { includeVideoInfoOnExport = v; },
    };
    trackingFolder.add(includeInfoParams, 'includeVideoInfo')
        .name(t("tracking.includeVideoInfo.label"))
        .tooltip(t("tracking.includeVideoInfo.tooltip"))
        .listen()
        .perm();

    const radiusParams = {
        get trackRadius() { return objectTracker?.trackRadius ?? 30; },
        set trackRadius(v) { 
            if (objectTracker) {
                objectTracker.trackRadius = v;
                setRenderOne(true);
            }
        }
    };
    
    radiusController = trackingFolder.add(radiusParams, 'trackRadius', 10, 100, 1)
        .name(t("tracking.trackRadius.label"))
        .tooltip(t("tracking.trackRadius.tooltip"))
        .listen()
        .perm();

    const searchRadiusParams = {
        get searchRadius() { return objectTracker?.searchRadius ?? 50; },
        set searchRadius(v) { 
            if (objectTracker) {
                objectTracker.searchRadius = v;
                setRenderOne(true);
            }
        }
    };
    
    trackingFolder.add(searchRadiusParams, 'searchRadius', 20, 300, 1)
        .name(t("tracking.searchRadius.label"))
        .tooltip(t("tracking.searchRadius.tooltip"))
        .listen()
        .perm();

    const trackingMethodOptions = {
        'Template Match': 'template',
        'Optical Flow': 'opticalflow',
        'Center on Bright': 'centerOnBright',
        'Center on Dark': 'centerOnDark',
        'Center on Color': 'centerOnColor',
        'High Peak': 'highPeak',
        'Low Peak': 'lowPeak',
        'Motion (Background)': 'motion',
        ...(isLocal ? {'SAM2 (Meta)': 'sam2'} : {}),
    };
    
    const trackingMethodParams = {
        get trackingMethod() {
            const method = objectTracker?.trackingMethod ?? pendingTrackingSettings.trackingMethod;
            return Object.keys(trackingMethodOptions).find(k => trackingMethodOptions[k] === method) || 'Template Match';
        },
        set trackingMethod(v) {
            pendingTrackingSettings.trackingMethod = trackingMethodOptions[v] || 'template';
            if (objectTracker) {
                objectTracker.trackingMethod = pendingTrackingSettings.trackingMethod;
                if (objectTracker.tracking) {
                    objectTracker.clearTrack();
                }
            }
            setRenderOne(true);
        }
    };

    trackingFolder.add(trackingMethodParams, 'trackingMethod', Object.keys(trackingMethodOptions))
        .name(t("tracking.trackingMethod.label"))
        .tooltip(t("tracking.trackingMethod.tooltip"))
        .listen()
        .perm();

    // Controls for the Motion (Background) method. Track Radius and Search
    // Radius above are reused as the target size and the gate, so only what is
    // specific to this method appears here.
    const motionPolarityOptions = {
        'Either': 'both',
        'Brighter than background': 'bright',
        'Darker than background': 'dark',
    };
    const setMotion = (key, value) => {
        pendingTrackingSettings[key] = value;
        if (objectTracker) objectTracker[key] = value;
    };
    const motionParams = {
        get motionPolarity() {
            const v = objectTracker?.motionPolarity ?? pendingTrackingSettings.motionPolarity;
            return Object.keys(motionPolarityOptions).find(k => motionPolarityOptions[k] === v) || 'Either';
        },
        set motionPolarity(v) { setMotion('motionPolarity', motionPolarityOptions[v] || 'both'); },
        get motionGap() { return objectTracker?.motionGap ?? pendingTrackingSettings.motionGap; },
        set motionGap(v) { setMotion('motionGap', v); },
        get motionSlack() { return objectTracker?.motionSlack ?? pendingTrackingSettings.motionSlack; },
        set motionSlack(v) { setMotion('motionSlack', v); },
        get motionThreshold() { return objectTracker?.motionThreshold ?? pendingTrackingSettings.motionThreshold; },
        set motionThreshold(v) { setMotion('motionThreshold', v); },
    };

    trackingFolder.add(motionParams, 'motionPolarity', Object.keys(motionPolarityOptions))
        .name(t("tracking.motionPolarity.label"))
        .tooltip(t("tracking.motionPolarity.tooltip"))
        .listen()
        .perm();

    trackingFolder.add(motionParams, 'motionGap', 1, 12, 1)
        .name(t("tracking.motionGap.label"))
        .tooltip(t("tracking.motionGap.tooltip"))
        .listen()
        .perm();

    trackingFolder.add(motionParams, 'motionSlack', 0, 5, 1)
        .name(t("tracking.motionSlack.label"))
        .tooltip(t("tracking.motionSlack.tooltip"))
        .listen()
        .perm();

    trackingFolder.add(motionParams, 'motionThreshold', 3, 30, 0.5)
        .name(t("tracking.motionThreshold.label"))
        .tooltip(t("tracking.motionThreshold.tooltip"))
        .listen()
        .perm();

    // The result has to appear on the button itself. A menu action whose only
    // output goes to the console reads as doing nothing at all, which is exactly
    // how this first landed.
    const analyseAction = {
        async analyseObject() {
            if (!objectTracker || analyseAction.busy) return;
            analyseAction.busy = true;
            const label = t("tracking.analyseObject.label");
            const show = (text) => { if (analyseMenuItem) analyseMenuItem.name(text); };
            try {
                const found = await objectTracker.analyseObject(
                    (step) => show(`${label}: ${step}...`));
                if (!found || found.error) {
                    show(`${label}: ${found?.error || "nothing found"}`);
                    console.warn("Analyse Object: " + (found?.error || "nothing measurable") +
                        " — put the cursor on the object, at a frame where it is visible.");
                } else {
                    show(`${found.polarity}, size ${found.featureScale}, gap ${found.gap}, `
                        + `slack ${found.slack} (${found.score.toFixed(0)} sigma)`);
                    console.log(`Analyse Object: ${found.polarity}, feature size `
                        + `${found.featureScale}, parallax slack ${found.slack} — the object `
                        + `stands out at ${found.score.toFixed(1)} sigma with those settings.`
                        + (found.alternatives?.length
                            ? ` Close alternatives: ${found.alternatives.join(", ")} —`
                              + ` this measures one frame, so if tracking fades later,`
                              + ` try one of those or re-analyse further into the clip.`
                            : ""));
                }
            } finally {
                analyseAction.busy = false;
                setRenderOne(true);
                setTimeout(() => show(label), 6000);
            }
        }
    };
    analyseMenuItem = trackingFolder.add(analyseAction, 'analyseObject')
        .name(t("tracking.analyseObject.label"))
        .tooltip(t("tracking.analyseObject.tooltip"))
        .perm();

    const motionFieldParams = {
        get showMotionField() { return objectTracker?.showMotionField ?? false; },
        set showMotionField(v) {
            if (objectTracker) {
                objectTracker.showMotionField = v;
                if (!v) {
                    objectTracker.motionFieldResolutionSession?.end();
                    objectTracker.motionFieldResolutionSession = null;
                }
                objectTracker.motionFieldCache = null;
                setRenderOne(true);
            }
        }
    };
    trackingFolder.add(motionFieldParams, 'showMotionField')
        .name(t("tracking.showMotionField.label"))
        .tooltip(t("tracking.showMotionField.tooltip"))
        .listen()
        .perm();

    // Feature Size: Gaussian sigma in image pixels for the High Peak / Low Peak
    // methods. Sliding shows a peak-marker preview overlay so the user can see
    // which features the algorithm currently treats as blobs.
    const featureSizeParams = {
        get featureSize() { return objectTracker?.featureSize ?? 1.5; },
        set featureSize(v) {
            if (objectTracker) {
                objectTracker.featureSize = v;
                setRenderOne(true);
            }
        }
    };

    trackingFolder.add(featureSizeParams, 'featureSize', 1, 20, 0.5)
        .name("Feature Size")
        .tooltip("Gaussian blur sigma (px) for High/Low Peak detection. Higher = smoother / larger features. Slide to preview detected peaks.")
        .onChange(() => {
            if (objectTracker) {
                objectTracker.featureSizePreview = true;
                setRenderOne(true);
            }
        })
        .onFinishChange(() => {
            if (objectTracker) {
                objectTracker.featureSizePreview = false;
                setRenderOne(true);
            }
        })
        .listen()
        .perm();

    const maskParams = {
        get useMask() { return objectTracker?.useMask ?? true; },
        set useMask(v) {
            if (objectTracker) {
                objectTracker.useMask = v;
                setRenderOne(true);
            }
        }
    };

    trackingFolder.add(maskParams, 'useMask')
        .name(t("tracking.useMask.label"))
        .tooltip(t("tracking.useMask.tooltip"))
        .perm();

    const brightnessParams = {
        get brightnessThreshold() { return objectTracker?.brightnessThreshold ?? 128; },
        set brightnessThreshold(v) {
            if (objectTracker) {
                objectTracker.brightnessThreshold = v;
                setRenderOne(true);
            }
        }
    };

    trackingFolder.add(brightnessParams, 'brightnessThreshold', 0, 255, 1)
        .name(t("tracking.brightnessThreshold.label"))
        .tooltip(t("tracking.brightnessThreshold.tooltip"))
        .onChange(() => {
            if (objectTracker) {
                objectTracker.thresholdPreview = true;
                setRenderOne(true);
            }
        })
        .onFinishChange(() => {
            if (objectTracker) {
                objectTracker.thresholdPreview = false;
                setRenderOne(true);
            }
        })
        .listen()
        .perm();

    // Center on Color controls. Same getter/setter shape as the brightness
    // threshold so listen() can keep the GUI in sync if the tracker is
    // created or replaced after the menu is built.
    const colorParams = {
        get trackingColor() { return objectTracker?.trackingColor ?? new Color(0xff0000); },
        set trackingColor(v) {
            if (objectTracker) {
                if (v instanceof Color) {
                    objectTracker.trackingColor.copy(v);
                } else {
                    objectTracker.trackingColor = new Color(v);
                }
                setRenderOne(true);
            }
        }
    };

    trackingFolder.addColor(colorParams, 'trackingColor')
        .name(t("tracking.trackingColor.label"))
        .tooltip(t("tracking.trackingColor.tooltip"))
        .onChange(() => {
            if (objectTracker) {
                objectTracker.thresholdPreview = true;
                setRenderOne(true);
            }
        })
        .onFinishChange(() => {
            if (objectTracker) {
                objectTracker.thresholdPreview = false;
                setRenderOne(true);
            }
        })
        .listen()
        .perm();

    const colorDistanceParams = {
        get colorDistance() { return objectTracker?.colorDistance ?? 80; },
        set colorDistance(v) {
            if (objectTracker) {
                objectTracker.colorDistance = v;
                setRenderOne(true);
            }
        }
    };

    // Max RGB Euclidean distance is sqrt(3) * 255 ≈ 441; rounded to 442 so the
    // slider can hit "everything matches" exactly.
    trackingFolder.add(colorDistanceParams, 'colorDistance', 0, 442, 1)
        .name(t("tracking.colorDistance.label"))
        .tooltip(t("tracking.colorDistance.tooltip"))
        .onChange(() => {
            if (objectTracker) {
                objectTracker.thresholdPreview = true;
                setRenderOne(true);
            }
        })
        .onFinishChange(() => {
            if (objectTracker) {
                objectTracker.thresholdPreview = false;
                setRenderOne(true);
            }
        })
        .listen()
        .perm();

    const editHeadOnlyParams = {
        get editHeadOnly() { return objectTracker?.editHeadOnly ?? false; },
        set editHeadOnly(v) {
            if (objectTracker) {
                objectTracker.editHeadOnly = v;
                setRenderOne(true);
            }
        }
    };

    trackingFolder.add(editHeadOnlyParams, 'editHeadOnly')
        .name(t("tracking.editHeadOnly.label"))
        .tooltip(t("tracking.editHeadOnly.tooltip"))
        .listen()
        .perm();

    const showMaxKeyframesParams = {
        get showMaxKeyframes() { return objectTracker?.showMaxKeyframes ?? 20; },
        set showMaxKeyframes(v) {
            if (objectTracker) {
                objectTracker.showMaxKeyframes = v;
                setRenderOne(true);
            }
        }
    };

    trackingFolder.add(showMaxKeyframesParams, 'showMaxKeyframes', 0, 100, 1)
        .name("Show N Keyframes")
        .listen()
        .perm();
}

export function getObjectTracker() {
    return objectTracker;
}

export function serializeAutoTracking() {
    if (!objectTracker) return null;
    if (objectTracker.trackedPositions.size === 0) return null;

    const videoView = objectTracker.videoView;
    const videoData = videoView?.videoData;

    // Positions are already in original-video coords (the runtime contract),
    // so no scaling is needed at serialize time.
    return {
        coordSpace: "original",
        // Whether the tracker is switched on. Disabling leaves the tracker and its
        // trackedPositions intact, so without this flag a disabled tracker serializes
        // identically to an enabled one and always comes back enabled.
        enabled: objectTracker.enabled,
        referenceVideoWidth: videoData?.originalVideoWidth ?? null,
        referenceVideoHeight: videoData?.originalVideoHeight ?? null,
        trackX: objectTracker.trackX,
        trackY: objectTracker.trackY,
        trackRadius: objectTracker.trackRadius,
        searchRadius: objectTracker.searchRadius,
        brightnessThreshold: objectTracker.brightnessThreshold,
        trackingColor: "#" + objectTracker.trackingColor.getHexString(),
        colorDistance: objectTracker.colorDistance,
        useMask: objectTracker.useMask,
        featureSize: objectTracker.featureSize,
        smoothingFrames: objectTracker.smoothingFrames,
        trackingMethod: objectTracker.trackingMethod,
        // Motion (Background) settings. trackingMethod is saved, so without
        // these a sitch saved with this method reopens using it with different
        // parameters — the track would not reproduce.
        motionPolarity: objectTracker.motionPolarity,
        motionGap: objectTracker.motionGap,
        motionSamples: objectTracker.motionSamples,
        motionSlack: objectTracker.motionSlack,
        motionThreshold: objectTracker.motionThreshold,
        showMaxKeyframes: objectTracker.showMaxKeyframes,
        editHeadOnly: objectTracker.editHeadOnly,
        trackedPositions: Array.from(objectTracker.trackedPositions.entries()),
        unmeasuredFrames: Array.from(objectTracker.trackedPositions.unmeasuredFrames || []),
        // Which frames were placed manually (vs auto-tracked) — drives the
        // keyframe overlay (magenta circles) and the "delete keyframe under
        // cursor" hit-test.
        manualKeyframes: Array.from(objectTracker.manualKeyframes),
        stabilizationEnabled: videoData?.stabilizationEnabled ?? false,
        stabilizationDirectOffset: videoData?.stabilizationDirectOffset ?? false,
        stabilizeCenters: videoData?.stabilizeCenters ?? true,
    };
}

export async function deserializeAutoTracking(data) {
    if (!data) return;

    const videoView = NodeMan.get("video", false);
    if (!videoView) return;

    // Tracker positions, stabilization data, and stabilization reference point
    // all live in the source video's *original* coordinate space (referenced to
    // videoData.originalVideoWidth × originalVideoHeight). Boundary code scales
    // to the actual decoded image dimensions only where pixels are touched
    // (renderOverlay, getStabilizedImage, tracking algorithms). This keeps
    // saves immune to the videoMaxSize quality preset and avoids the load-time
    // race where videoData.videoWidth reads as the pre-resize value.
    const videoData = videoView.videoData;
    if (!videoData) return;

    // Create the tracker. Whether it is switched on is saved state; saves made
    // before the `enabled` flag existed have tracking data only, so a missing
    // flag means "on" — the behaviour those saves were made under.
    if (!objectTracker) {
        objectTracker = new ObjectTracker(videoView);
        applyPendingTrackingSettings(objectTracker);
        // Local-only debug hook so MCP / console can reach the module-scoped
        // tracker (mirrors the tools-page window.shf pattern). Never exposed in
        // production builds.
        if (isLocal) window._objectTracker = objectTracker;
    }
    const enableTracker = data.enabled ?? true;
    if (enableTracker) {
        objectTracker.enable();
    } else if (objectTracker.enabled) {
        // Only when a live tracker carried over from a previous sitch; a freshly
        // constructed one is already disabled. The overlay is deliberately left
        // uncreated - creating it would install the tracker's mouse handlers over
        // the video view's own, and createOverlay() no longer recenters a restored
        // track, so deferring it to the user's first enable is safe.
        objectTracker.disable();
    }
    if (enableMenuItem) {
        enableMenuItem.name(enableTracker ? t("tracking.enable.disableLabel") : t("tracking.enable.label"));
    }

    // Hook rendering if not already done
    if (!renderHooked) {
        renderHooked = true;
        const originalRender = videoView.renderCanvas.bind(videoView);
        videoView.renderCanvas = function(frame) {
            originalRender(frame);
            if (objectTracker && objectTracker.enabled) {
                objectTracker.renderOverlay(frame);
            }
        };
    }

    // Restore tracker state (positions stored in original-video coords)
    objectTracker.trackX = data.trackX ?? 0;
    objectTracker.trackY = data.trackY ?? 0;
    // The restored position has to survive a createOverlay() that happens later:
    // a track loaded disabled does not build its overlay until the user first
    // enables it, by which point the track may even have been cleared.
    if (data.trackX !== undefined) {
        objectTracker.trackPositionSet = true;
    }
    objectTracker.trackRadius = data.trackRadius ?? 30;
    objectTracker.searchRadius = data.searchRadius ?? 50;
    objectTracker.brightnessThreshold = data.brightnessThreshold ?? 128;
    if (data.trackingColor !== undefined) {
        objectTracker.trackingColor = new Color(data.trackingColor);
    }
    objectTracker.colorDistance = data.colorDistance ?? 80;
    objectTracker.useMask = data.useMask ?? true;
    objectTracker.featureSize = data.featureSize ?? 1.5;
    objectTracker.smoothingFrames = normalizeTrackSmoothing(data.smoothingFrames);
    objectTracker.showMaxKeyframes = data.showMaxKeyframes ?? 20;
    objectTracker.editHeadOnly = data.editHeadOnly ?? false;
    objectTracker.motionPolarity = data.motionPolarity ?? 'both';
    objectTracker.motionGap = data.motionGap ?? 3;
    objectTracker.motionSamples = data.motionSamples ?? 8;
    objectTracker.motionSlack = data.motionSlack ?? 0;
    objectTracker.motionThreshold = data.motionThreshold ?? 6;
    // Legacy migration: pre-2.50.7 saves used separate centerOnBright/Dark
    // checkboxes. Map them onto the unified trackingMethod dropdown.
    if (data.trackingMethod) {
        objectTracker.trackingMethod = data.trackingMethod;
    } else if (data.centerOnBright) {
        objectTracker.trackingMethod = 'centerOnBright';
    } else if (data.centerOnDark) {
        objectTracker.trackingMethod = 'centerOnDark';
    } else {
        objectTracker.trackingMethod = 'template';
    }

    if (data.trackedPositions) {
        objectTracker.trackedPositions = new Map(
            data.trackedPositions.map(([f, p]) => [f, {x: p.x, y: p.y,
                ...(p.estimated ? {estimated: p.estimated} : {})}])
        );
    }
    objectTracker.trackedPositions.unmeasuredFrames = new Set(data.unmeasuredFrames ?? []);
    objectTracker.manualKeyframes = new Set(data.manualKeyframes ?? []);

    // Tracker tracks the original video size for the "video changed?" check
    const origW = videoData.originalVideoWidth || videoData.videoWidth || 0;
    const origH = videoData.originalVideoHeight || videoData.videoHeight || 0;
    objectTracker.lastVideoWidth = origW;
    objectTracker.lastVideoHeight = origH;

    // Restore stabilization if there's tracking data
    if (data.stabilizationEnabled && objectTracker.trackedPositions.size > 0) {
        const outputPositions = objectTracker.getOutputPositions();
        const firstFrame = Math.min(...outputPositions.keys());
        const referencePoint = outputPositions.get(firstFrame);
        if (referencePoint) {
            videoData.stabilizeCenters = data.stabilizeCenters ?? true;
            videoData.setStabilizationData(
                outputPositions,
                referencePoint,
                data.stabilizationDirectOffset ?? false
            );
            videoData.setStabilizationEnabled(true);
            if (stabilizeToggleMenuItem) {
                stabilizeToggleMenuItem.name(t("tracking.stabilizeToggle.disableLabel"));
            }
        }
    }

    setRenderOne(true);
}
