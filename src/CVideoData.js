import {assert} from "./assert";

export function interpolatePosition(positionsMap, frame) {
    if (positionsMap.has(frame)) {
        return positionsMap.get(frame);
    }
    if (positionsMap.size === 0) {
        return null;
    }
    const frames = Array.from(positionsMap.keys()).sort((a, b) => a - b);
    let prevFrame = null;
    let nextFrame = null;
    for (const f of frames) {
        if (f < frame) prevFrame = f;
        else if (f > frame) {
            nextFrame = f;
            break;
        }
    }
    if (prevFrame !== null && nextFrame !== null) {
        const prevPos = positionsMap.get(prevFrame);
        const nextPos = positionsMap.get(nextFrame);
        const t = (frame - prevFrame) / (nextFrame - prevFrame);
        return {
            x: prevPos.x + (nextPos.x - prevPos.x) * t,
            y: prevPos.y + (nextPos.y - prevPos.y) * t
        };
    }
    // Extrapolate past the last keyframe using the last two keyframes
    if (prevFrame !== null) {
        if (frames.length >= 2) {
            const f1 = frames[frames.length - 2];
            const f2 = frames[frames.length - 1];
            const p1 = positionsMap.get(f1);
            const p2 = positionsMap.get(f2);
            const t = (frame - f1) / (f2 - f1);
            return {
                x: p1.x + (p2.x - p1.x) * t,
                y: p1.y + (p2.y - p1.y) * t
            };
        }
        return positionsMap.get(prevFrame);
    }
    // Extrapolate before the first keyframe using the first two keyframes
    if (nextFrame !== null) {
        if (frames.length >= 2) {
            const f1 = frames[0];
            const f2 = frames[1];
            const p1 = positionsMap.get(f1);
            const p2 = positionsMap.get(f2);
            const t = (frame - f1) / (f2 - f1);
            return {
                x: p1.x + (p2.x - p1.x) * t,
                y: p1.y + (p2.y - p1.y) * t
            };
        }
        return positionsMap.get(nextFrame);
    }
    return null;
}

export class CVideoData {
    constructor(v) {
        this.id = v.id;
        this.percentLoaded = 0;

        this.frames = v.frames

        this.videoSpeed = v.videoSpeed ?? 1 // what speed the original video was

        // increase the number of frames
        // to account for original speed
        // e.g. if video was 10x timelapse, then we need 10x the virtual frames
        // to play back in real time
        this.frames *= this.videoSpeed;

        // just give some defaults. actual images will override
        this.videoWidth = 100
        this.videoHeight = 100

        // Original video dimensions (before any resizing due to videoMaxSize setting)
        // These are set once when the video is first loaded and never changed
        // Used for tracking/analysis coordinate conversion
        this.originalVideoWidth = 0
        this.originalVideoHeight = 0

        // Rotation support
        // metadataRotation: rotation from video container metadata (e.g., phone videos)
        // userRotation: rotation set by user via UI dropdown
        // effectiveRotation: combined rotation (metadataRotation + userRotation) % 360
        this.metadataRotation = 0;  // 0, 90, 180, or 270 degrees
        this.userRotation = 0;      // 0, 90, 180, or 270 degrees

        // Stabilization support
        this.stabilizationEnabled = false;
        this.stabilizationData = null;  // Map of frame -> {x, y} offsets
        this.stabilizationReferencePoint = null; // {x, y} - the fixed point
        this.stabilizationDirectOffset = false;  // true = use offsets directly (motion analysis)
        this.stabilizeCenters = true;  // true = center tracked point in view, false = keep at initial position
        this.stabilizedImageCache = [];  // Cache for stabilized frames

        this.flushEntireCache();

    }

    /**
     * Get the effective rotation combining metadata and user rotation
     * @returns {number} Combined rotation in degrees (0, 90, 180, or 270)
     */
    get effectiveRotation() {
        return (this.metadataRotation + this.userRotation) % 360;
    }

    /**
     * Set user rotation and trigger cache flush
     * @param {number} degrees - Rotation in degrees (0, 90, 180, or 270)
     */
    setUserRotation(degrees) {
        // Normalize to 0, 90, 180, 270
        degrees = ((degrees % 360) + 360) % 360;
        if (this.userRotation === degrees) return;
        this.userRotation = degrees;
        this.onRotationChanged();
    }

    /**
     * Called when rotation changes - flushes caches and disables stabilization
     * Subclasses can override to add additional cleanup
     */
    onRotationChanged() {
        this.flushEntireCache();
        // Disable stabilization as offsets are no longer valid after rotation
        this.setStabilizationEnabled(false);
        this.stabilizationData = null;
    }

    // virtual functions
    getImage(frame) {
        assert(0, "CVideoData: getImage: not implemented")
        return null;
    }

    // Per-frame Presentation Time Stamp in milliseconds, relative to start of stream.
    // Default returns null meaning "no real per-frame timing available — caller
    // should fall back to nominal frame_index/fps". Subclasses with access to
    // container-level PTS (e.g. WebCodec MP4/H.264) override this to return the
    // actual decoded frame timestamp, which is what makes long-clip MISB/KLV
    // sync drift-free.
    getFrameTimeMs(frame) {
        return null;
    }

    // True when framePTSus[] contains real per-frame PTS captured from PES /
    // container metadata (i.e. honors recording-time gaps from dropped frames).
    // False when timestamps are synthetic uniform i × frameDuration, which
    // pretend every frame is at its nominal slot regardless of frame loss.
    // Track-pairing code uses this to decide whether to trust framePTSus.
    hasRealFramePTS() {
        return false;
    }

    isFrameLoaded(frame) {
        const img = this.imageCache[frame];
        return img && img.width > 0 && img.height > 0;
    }

    async waitForFrame(frame, timeout = 5000) {
        this.getImage(frame);
        const start = performance.now();
        while (!this.isFrameLoaded(frame)) {
            if (performance.now() - start > timeout) {
                console.warn(`waitForFrame timeout for frame ${frame}`);
                return false;
            }
            await new Promise(r => setTimeout(r, 10));
        }
        return true;
    }

    update() {
        // nothing to do here
    }

    // Set stabilization data from tracking
    // directOffset: if true, trackingData contains direct pixel offsets to apply
    //               if false, trackingData contains tracked positions to center on referencePoint
    setStabilizationData(trackingData, referencePoint, directOffset = false) {
        this.stabilizationData = new Map(trackingData);
        this.stabilizationReferencePoint = referencePoint;
        this.stabilizationDirectOffset = directOffset;
        this.stabilizedImageCache = [];
    }

    // Enable/disable stabilization
    setStabilizationEnabled(enabled) {
        this.stabilizationEnabled = enabled;
        if (!enabled) {
            // Clear cache when disabling
            this.stabilizedImageCache = [];
        }
    }

    // Get stabilized image for a frame
    // sourceFrame: the actual frame index the originalImage came from (may differ if using substitute frame)
    getStabilizedImage(frame, originalImage, sourceFrame = undefined) {
        if (!this.stabilizationEnabled || !this.stabilizationData || !this.stabilizationReferencePoint) {
            return originalImage;
        }

        const f = Math.floor(frame);
        const sf = sourceFrame !== undefined ? Math.floor(sourceFrame) : f;
        const isExactFrame = sf === f;

        // Only use cache if this is the exact frame (not a substitute)
        if (isExactFrame && this.stabilizedImageCache[f]) {
            return this.stabilizedImageCache[f];
        }

        // Use source frame's stabilization offset when using substitute image
        let trackPos = interpolatePosition(this.stabilizationData, sf);
        if (!trackPos) {
            return originalImage;
        }
        let refPoint = this.stabilizationReferencePoint;

        // Stabilization positions live in original-video coordinates
        // (referenced to originalVideoWidth/Height). The image we're shifting
        // is at the actual decoded resolution after the videoMaxSize quality
        // preset, so scale positions to image coords before computing shifts.
        // Direct-offset mode (motion analysis) bypasses this — the offsets are
        // already deltas in the displayed image space.
        if (!this.stabilizationDirectOffset
            && this.originalVideoWidth && this.originalVideoHeight) {
            const w = originalImage.width || originalImage.videoWidth || this.originalVideoWidth;
            const h = originalImage.height || originalImage.videoHeight || this.originalVideoHeight;
            const sx = w / this.originalVideoWidth;
            const sy = h / this.originalVideoHeight;
            trackPos = {x: trackPos.x * sx, y: trackPos.y * sy};
            if (refPoint) {
                refPoint = {x: refPoint.x * sx, y: refPoint.y * sy};
            }
        }

        // Calculate shift based on mode
        let shiftX, shiftY;
        if (this.stabilizationDirectOffset) {
            // Direct offset mode (motion analysis): offsets are cumulative motion to cancel
            shiftX = trackPos.x;
            shiftY = trackPos.y;
        } else if (this.stabilizeCenters) {
            // Center mode: shift to keep tracked point at center of view
            const w = originalImage.width || originalImage.videoWidth;
            const h = originalImage.height || originalImage.videoHeight;
            shiftX = w / 2 - trackPos.x;
            shiftY = h / 2 - trackPos.y;
        } else {
            // Point tracking mode: shift to keep tracked point at reference position
            shiftX = refPoint.x - trackPos.x;
            shiftY = refPoint.y - trackPos.y;
        }

        // Create shifted image
        const canvas = document.createElement('canvas');
        canvas.width = originalImage.width || originalImage.videoWidth;
        canvas.height = originalImage.height || originalImage.videoHeight;
        const ctx = canvas.getContext('2d');

        // Fill with black background
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw shifted image
        ctx.drawImage(originalImage, shiftX, shiftY);

        // Only cache if this is the exact frame, not a substitute
        if (isExactFrame) {
            this.stabilizedImageCache[f] = canvas;
        }

        return canvas;
    }

    flushEntireCache() {

        this.imageCache = [] // full sized images
        this.imageDataCache = []
        this.frameCache = []
        this.stabilizedImageCache = []

        for (let i = 0; i < this.frames; i++) {
            this.imageCache.push(new Image())
            this.imageDataCache.push(null)
        }

    }

    stopStreaming() {
        this.flushEntireCache()
    }

    dispose() {
        this.stopStreaming()
        this.imageCache = null
        this.imageDataCache = null
        this.frameCache = null
        this.imageCacheTiny = null
    }

}