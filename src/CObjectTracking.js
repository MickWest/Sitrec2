import {GlobalDateTimeNode, Globals, guiMenus, NodeMan, setRenderOne, Sit, unregisterFrameBlocker} from "./Globals";
import {par} from "./par";
import {getCV, loadOpenCV} from "./openCVLoader";
import {getJsfeat, loadJsfeat} from "./jsfeatLoader";
import {interpolatePosition} from "./CVideoData";
import {EventManager} from "./CEventManager";
import {KeyMan} from "./KeyBoardHandler";
import {createVideoExporter, DefaultVideoFormat, getBestFormatForResolution, getVideoExtension} from "./VideoExporter";
import {drawVideoWatermark, ExportProgressWidget, getExportPrefix} from "./utils";
import {drawAttributionOnCanvas} from "./AttributionOverlay";
import {isLocal} from "./configUtils";
import {t} from "./i18n";
import {Color} from "three";

let cv = null;

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

class ObjectTracker {
    constructor(videoView) {
        this.videoView = videoView;
        this.enabled = false;
        this.tracking = false;
        this.overlayCreated = false;
        this.overlay = null;
        this.overlayCtx = null;

        this.trackX = 0;
        this.trackY = 0;
        this.trackRadius = 30;

        this.trackedPositions = new Map();
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
        //   'sam2'            — server-side SAM2 segmentation
        this.trackingMethod = 'template';

        // Maximum number of keyframes to display (0 = none, 100 = all)
        this.showMaxKeyframes = 20;

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
        
        const {width, height} = this.getImageDimensions();
        this.trackX = width / 2;
        this.trackY = height / 2;
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
                
                const clickedKeyframe = this.findClickedKeyframe(vX, vY);
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
                this.runHoldLoop(key === "'" ? 'forward' : 'backward');
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
        if (direction === 'forward') {
            this.tracking = true;
            this.initializeTracker();
            Globals.justVideoAnalysis = true;
        }

        try {
            while (KeyMan.isKeyHeld(heldKey)) {
                const tickStart = performance.now();
                const cur = Math.floor(par.frame);

                if (direction === 'forward') {
                    const nf = cur + 1;
                    if (nf > lastFrame) break;
                    par.frame = nf;
                    videoData.getImage(nf);
                    await videoData.waitForFrame(nf, 5000);
                    if (!KeyMan.isKeyHeld(heldKey)) break;
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
        this.enabled = false;
        this.tracking = false;
        this.hideOverlay();
        this.clearSliderStatus();
        unregisterFrameBlocker('objectTracking');
    }
    
    startTracking() {
        if (!this.enabled) return;
        this.tracking = true;
        this.initializeTracker();
        this.updateSliderStatus();

        this.savedPaused = par.paused;
        this.savedFrame = par.frame;
        Globals.justVideoAnalysis = true;
        par.paused = true;  // Pause the animation loop

        // Start fast tracking loop
        this.runFastTrackingLoop();
    }
    
    async runFastTrackingLoop() {
        const startFrame = Math.floor(par.frame);
        const bFrame = Sit.bFrame ?? (Sit.frames - 1);
        const videoData = this.videoView?.videoData;

        if (!videoData) {
            this.onTrackingComplete();
            return;
        }

        // Target 25 FPS for visual updates (40ms per render)
        const targetRenderInterval = 40; // ms
        let lastRenderTime = performance.now();

        const wrapperHasHolds = typeof videoData.isHeldFrame === "function";

        for (let frame = startFrame; frame <= bFrame; frame++) {
            if (!this.tracking) break;

            // Set current frame
            par.frame = frame;

            // Skip held (synthesized duplicate) frames: identical pixels as
            // the prior canonical V, so template-matching would produce the
            // same answer at the same wall-clock budget. Carry the previous
            // tracked position forward so any consumer reading
            // trackedPositions.get(frame) sees a value, but skip the work.
            if (wrapperHasHolds && videoData.isHeldFrame(frame)) {
                const prev = this.trackedPositions.get(frame - 1);
                if (prev) this.trackedPositions.set(frame, {x: prev.x, y: prev.y});
                continue;
            }

            // Wait for video frame to be loaded (with timeout)
            videoData.getImage(frame);
            await videoData.waitForFrame(frame, 5000);

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
                await new Promise(resolve => setTimeout(resolve, 0));
            }
        }

        // Tracking complete
        this.onTrackingComplete();
    }

    stopTracking() {
        this.tracking = false;
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
        if (startMenuItem) startMenuItem.name(t("tracking.start.label"));
        setRenderOne(true);
    }
    
    initializeTracker() {
        const frame = Math.floor(par.frame);
        this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
        
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

        for (let roiY = 0; roiY < roiHeight; roiY++) {
            for (let roiX = 0; roiX < roiWidth; roiX++) {
                const imgX = minX + roiX;
                const imgY = minY + roiY;

                // Circular gate (the ROI rectangle is larger than the disk)
                const dx = imgX - centerX;
                const dy = imgY - centerY;
                if (dx * dx + dy * dy > radiusSquared) continue;

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

    // Thin wrappers — preserved so existing call sites keep working.
    // Each just supplies the appropriate weight rule.
    calculateBrightCentroid(image, centerX, centerY, radius) {
        return this.calculateWeightedCentroid(image, centerX, centerY, radius,
            (r, g, b) => this._brightWeight(r, g, b));
    }

    calculateDarkCentroid(image, centerX, centerY, radius) {
        return this.calculateWeightedCentroid(image, centerX, centerY, radius,
            (r, g, b) => this._darkWeight(r, g, b));
    }

    calculateColorCentroid(image, centerX, centerY, radius) {
        return this.calculateWeightedCentroid(image, centerX, centerY, radius,
            (r, g, b) => this._colorWeight(r, g, b));
    }

    trackFrame(frame, force = false) {
        if (!this.tracking || !this.enabled) return;

        frame = Math.floor(frame);

        // Skip already-tracked frames in the full-speed loop. The ' hold-loop
        // passes force=true so the user can deliberately re-run tracking over
        // a stale section (e.g. a stuck auto-track that wrote the same dud
        // position across many frames).
        if (!force && this.trackedPositions.has(frame)) {
            const pos = this.trackedPositions.get(frame);
            this.trackX = pos.x;
            this.trackY = pos.y;
            return;
        }

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
            prevPos = this.predictPosition(frame) ?? this.getInterpolatedPosition(frame - 1);
        } else {
            prevPos = this.getInterpolatedPosition(frame - 1);
        }
        if (!prevPos) return;

        const videoData = this.videoView?.videoData;
        if (!videoData) return;

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
        this.trackRadius = trackRadiusTracker * sx;
        this.searchRadius = searchRadiusTracker * sx;
        try {
            fn(currImage, ip);
        } finally {
            this.trackRadius = trackRadiusTracker;
            this.searchRadius = searchRadiusTracker;
            // Algorithm wrote trackX/Y and trackedPositions[frame] in image
            // coords; map both back to tracker coords.
            this.trackX = this.trackX * origW / w;
            this.trackY = this.trackY * origH / h;
            this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
        }
    }

    // Shared "compute centroid → commit position" wrapper for all three
    // centroid-based methods. Falls back to the previous position when no
    // pixel passed the weight rule, matching the legacy behavior.
    _trackCentroid(frame, currImage, prevPos, calcFn) {
        const centroid = calcFn.call(this, currImage, prevPos.x, prevPos.y, this.trackRadius);
        if (centroid) {
            this.trackX = centroid.x;
            this.trackY = centroid.y;
        } else {
            this.trackX = prevPos.x;
            this.trackY = prevPos.y;
        }
        this.trackedPositions.set(frame, {x: this.trackX, y: this.trackY});
        this.updateSliderStatus();
    }

    trackBrightCentroid(frame, currImage, prevPos) {
        this._trackCentroid(frame, currImage, prevPos, this.calculateBrightCentroid);
    }

    trackDarkCentroid(frame, currImage, prevPos) {
        this._trackCentroid(frame, currImage, prevPos, this.calculateDarkCentroid);
    }

    trackColorCentroid(frame, currImage, prevPos) {
        this._trackCentroid(frame, currImage, prevPos, this.calculateColorCentroid);
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
        ctx.drawImage(tempCanvas, 0, 0, width, height);
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

        const {dWidth} = this.videoView;
        const refW = this.videoView.originalVideoWidth || this.videoView.videoWidth || 1;
        const canvasRadius = this.trackRadius * dWidth / refW;
        
        ctx.strokeStyle = this.tracking ? '#00ff00' : '#ffff00';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(cx, cy, canvasRadius, 0, Math.PI * 2);
        ctx.stroke();
        
        ctx.strokeStyle = this.tracking ? 'rgba(0, 255, 0, 0.5)' : 'rgba(255, 255, 0, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx - canvasRadius - 5, cy);
        ctx.lineTo(cx + canvasRadius + 5, cy);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx, cy - canvasRadius - 5);
        ctx.lineTo(cx, cy + canvasRadius + 5);
        ctx.stroke();
        
        ctx.font = '12px monospace';
        ctx.fillStyle = this.tracking ? '#00ff00' : '#ffff00';
        const status = this.tracking ? 'TRACKING' : 'ENABLED';
        ctx.fillText(`${status} (${Math.round(this.trackX)}, ${Math.round(this.trackY)})`, cx + canvasRadius + 10, cy);
        
        if (this.trackedPositions.size > 1) {
            ctx.strokeStyle = 'rgba(0, 255, 255, 0.5)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            let started = false;
            
            const sortedFrames = Array.from(this.trackedPositions.keys()).sort((a, b) => a - b);
            for (const f of sortedFrames) {
                const pos = this.trackedPositions.get(f);
                const offset = getStabOffset(f);
                const [px, py] = this.videoView.videoToCanvasCoordsOriginal(pos.x + offset.x, pos.y + offset.y);
                if (!started) {
                    ctx.moveTo(px, py);
                    started = true;
                } else {
                    ctx.lineTo(px, py);
                }
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
        for (const f of keyframesToDraw) {
            const pos = this.trackedPositions.get(f);
            if (pos) {
                const offset = getStabOffset(f);
                const [kx, ky] = this.videoView.videoToCanvasCoordsOriginal(pos.x + offset.x, pos.y + offset.y);
                ctx.strokeStyle = '#ff00ff';
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
        this.updateSliderStatus();
        setRenderOne(true);
    }

    getInterpolatedPosition(frame) {
        return interpolatePosition(this.trackedPositions, frame);
    }
    
    getCacheStatusArray() {
        const status = new Array(Sit.frames).fill(0);
        for (const f of this.trackedPositions.keys()) {
            if (f >= 0 && f < Sit.frames) {
                status[f] = 1;
            }
        }
        return status;
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
    const firstFrame = Math.min(...objectTracker.trackedPositions.keys());
    const referencePoint = objectTracker.trackedPositions.get(firstFrame);

    if (!referencePoint) {
        alert("Could not determine reference point.");
        return;
    }

    // Pass tracking data to video system
    videoData.setStabilizationData(objectTracker.trackedPositions, referencePoint);
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
function getStabilizationBounds() {
    if (!objectTracker || !objectTracker.trackedPositions || objectTracker.trackedPositions.size === 0) {
        return null;
    }

    const videoView = objectTracker.videoView;
    const videoData = videoView?.videoData;
    if (!videoData) return null;

    const firstFrame = Math.min(...objectTracker.trackedPositions.keys());
    const referencePoint = objectTracker.trackedPositions.get(firstFrame);
    if (!referencePoint) return null;

    // Use center of video as anchor when stabilizeCenters is enabled
    let anchorX, anchorY;
    if (videoData.stabilizeCenters && !videoData.stabilizationDirectOffset) {
        anchorX = videoData.videoWidth / 2;
        anchorY = videoData.videoHeight / 2;
    } else {
        anchorX = referencePoint.x;
        anchorY = referencePoint.y;
    }

    let minX = 0, maxX = 0, minY = 0, maxY = 0;

    for (const [frame, pos] of objectTracker.trackedPositions) {
        const shiftX = anchorX - pos.x;
        const shiftY = anchorY - pos.y;
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
    const firstFrame = Math.min(...objectTracker.trackedPositions.keys());
    const referencePoint = objectTracker.trackedPositions.get(firstFrame);

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
            await videoData.waitForFrame(frame);

            const originalImage = videoData.imageCache[frame];
            if (!originalImage || !originalImage.width) continue;

            // Calculate stabilization shift for this frame
            // Must match the logic in CVideoData.getStabilizedImage()
            const trackPos = interpolatePosition(objectTracker.trackedPositions, frame);
            let shiftX = 0, shiftY = 0;
            if (trackPos && referencePoint) {
                if (videoData.stabilizeCenters) {
                    shiftX = videoData.videoWidth / 2 - trackPos.x;
                    shiftY = videoData.videoHeight / 2 - trackPos.y;
                } else {
                    shiftX = referencePoint.x - trackPos.x;
                    shiftY = referencePoint.y - trackPos.y;
                }
            }

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

    trackingFolder = guiMenus.video.addFolder("Auto Tracking").close().perm();

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

    trackingFolder.add(menuActions, 'clearTrack')
        .name(t("tracking.clearTrack.label"))
        .tooltip(t("tracking.clearTrack.tooltip"))
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
        ...(isLocal ? {'SAM2 (Meta)': 'sam2'} : {}),
    };
    
    const trackingMethodParams = {
        get trackingMethod() { 
            const method = objectTracker?.trackingMethod ?? 'template';
            return Object.keys(trackingMethodOptions).find(k => trackingMethodOptions[k] === method) || 'Template Match';
        },
        set trackingMethod(v) {
            if (objectTracker) {
                objectTracker.trackingMethod = trackingMethodOptions[v] || 'template';
                if (objectTracker.tracking) {
                    objectTracker.clearTrack();
                }
                setRenderOne(true);
            }
        }
    };

    trackingFolder.add(trackingMethodParams, 'trackingMethod', Object.keys(trackingMethodOptions))
        .name(t("tracking.trackingMethod.label"))
        .tooltip(t("tracking.trackingMethod.tooltip"))
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

    trackingFolder.add(featureSizeParams, 'featureSize', 2, 20, 0.1)
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
        referenceVideoWidth: videoData?.originalVideoWidth ?? null,
        referenceVideoHeight: videoData?.originalVideoHeight ?? null,
        trackX: objectTracker.trackX,
        trackY: objectTracker.trackY,
        trackRadius: objectTracker.trackRadius,
        searchRadius: objectTracker.searchRadius,
        brightnessThreshold: objectTracker.brightnessThreshold,
        trackingColor: "#" + objectTracker.trackingColor.getHexString(),
        colorDistance: objectTracker.colorDistance,
        featureSize: objectTracker.featureSize,
        trackingMethod: objectTracker.trackingMethod,
        showMaxKeyframes: objectTracker.showMaxKeyframes,
        trackedPositions: Array.from(objectTracker.trackedPositions.entries()),
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

    // Create and enable the tracker
    if (!objectTracker) {
        objectTracker = new ObjectTracker(videoView);
    }
    objectTracker.enable();
    if (enableMenuItem) enableMenuItem.name(t("tracking.enable.disableLabel"));

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
    objectTracker.trackRadius = data.trackRadius ?? 30;
    objectTracker.searchRadius = data.searchRadius ?? 50;
    objectTracker.brightnessThreshold = data.brightnessThreshold ?? 128;
    if (data.trackingColor !== undefined) {
        objectTracker.trackingColor = new Color(data.trackingColor);
    }
    objectTracker.colorDistance = data.colorDistance ?? 80;
    objectTracker.featureSize = data.featureSize ?? 1.5;
    objectTracker.showMaxKeyframes = data.showMaxKeyframes ?? 20;
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
            data.trackedPositions.map(([f, p]) => [f, {x: p.x, y: p.y}])
        );
    }
    objectTracker.manualKeyframes = new Set(data.manualKeyframes ?? []);

    // Tracker tracks the original video size for the "video changed?" check
    const origW = videoData.originalVideoWidth || videoData.videoWidth || 0;
    const origH = videoData.originalVideoHeight || videoData.videoHeight || 0;
    objectTracker.lastVideoWidth = origW;
    objectTracker.lastVideoHeight = origH;

    // Restore stabilization if there's tracking data
    if (data.stabilizationEnabled && objectTracker.trackedPositions.size > 0) {
        const firstFrame = Math.min(...objectTracker.trackedPositions.keys());
        const referencePoint = objectTracker.trackedPositions.get(firstFrame);
        if (referencePoint) {
            videoData.stabilizeCenters = data.stabilizeCenters ?? true;
            videoData.setStabilizationData(
                objectTracker.trackedPositions,
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
