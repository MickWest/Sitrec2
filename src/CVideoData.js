import {assert} from "./assert";

// Each stabilized frame is a full-size canvas (8 MB at 1080p), so keep only the
// most recent few. Caching every frame played used gigabytes within a minute.
const STABILIZED_CACHE_FRAMES = 8;

export function interpolatePosition(positionsMap, frame) {
    if (positionsMap.has(frame)) {
        return positionsMap.get(frame);
    }
    if (positionsMap.unmeasuredFrames?.has(Math.floor(frame))) return null;
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
    // A known loss also blocks interpolation across the interval and
    // extrapolation beyond a stopped run whose tail is still missing.
    for (const f of positionsMap.unmeasuredFrames || []) {
        if (f > (prevFrame ?? -Infinity) && f < (nextFrame ?? Infinity)) return null;
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

// A 2D affine map {a, b, c, d, e, f}: x' = a*x + c*y + e, y' = b*x + d*y + f. The order of the
// six numbers is the order canvas setTransform() takes them.
export function applyAffine(m, x, y) {
    return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

export function invertAffine(m) {
    const det = m.a * m.d - m.b * m.c;
    if (!det) return null;
    return {a: m.d / det, b: -m.b / det, c: -m.c / det, d: m.a / det,
        e: (m.c * m.f - m.d * m.e) / det, f: (m.b * m.e - m.a * m.f) / det};
}

// The stabilization on the picture that a video view shows at sitch frame `frame`, in the
// pixels of a width x height picture. The view gives getImage() its stream frame (Lock to In
// Frame), and getImage() divides that by the video speed, so the map is that frame's. An
// overlay drawn on the picture must use this, or it moves with another frame's map.
export function viewStabilizationMatrix(view, frame, width, height) {
    const video = view?.videoData;
    if (!video?.stabilizationMatrix) return null;
    return video.stabilizationMatrix(viewVideoFrame(view, frame), width, height);
}

// The video's own frame number for sitch frame `frame` in a video view: the frame that
// getImage() decodes and stabilizes.
export function viewVideoFrame(view, frame) {
    const f = Math.floor(frame);
    const stream = view?.streamFrame ? view.streamFrame(f) : f;
    return Math.floor(stream / (view?.videoData?.videoSpeed || 1));
}

export class CVideoData {
    constructor(v) {
        this.id = v.id;
        this.percentLoaded = 0;

        this.frames = v.frames

        this.videoSpeed = v.videoSpeed ?? 1 // what speed the original video was

        // Whether this video "owns" the global sitch timeline. The primary video
        // view ("video") defines Sit.frames/Sit.fps/Sit.videoFrames and resets the
        // playhead when it loads. A secondary view ("video2", twovid) must NOT —
        // otherwise a second clip with a different length/fps silently redefines
        // the sitch timeline and desyncs everything (see C1 in the 2.70.0 merge
        // review). Defaults true so single-video behavior is unchanged.
        this.ownsTimeline = v.ownsTimeline ?? true;

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
        // Set by setStabilizationTransforms(): stabilizationData then holds a 2D map per frame,
        // in pixels of a picture this size ({width, height}), which can rotate as well as shift.
        this.stabilizationAffine = null;
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
        this.stabilizationAffine = null;
    }

    // Container/stream facts about this media, for display in the EXIF/Metadata panel.
    // Everything a plain image can answer lives here; the codec-backed subclasses add
    // codec, bitrate, duration and audio. Undefined fields are simply not shown, so a
    // subclass only has to report what it actually knows.
    getMediaInfo() {
        return {
            width: this.videoWidth,
            height: this.videoHeight,
            frames: this.frames,
            fps: this.fps,
            // analyzeFrameTiming (VFRTimeline.js), set when the video loads
            frameTiming: this.frameTiming,
        };
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
        this.stabilizationData.unmeasuredFrames = trackingData.unmeasuredFrames;
        this.stabilizationReferencePoint = referencePoint;
        this.stabilizationDirectOffset = directOffset;
        this.stabilizationAffine = null;
        this.stabilizedImageCache = [];
        this._stabilizationRevision = (this._stabilizationRevision ?? 0) + 1;
    }

    // Stabilization that can rotate as well as shift. `transforms` maps a frame to the 2D map
    // (applyAffine) from that frame's picture to the stabilized picture, in pixels of a picture
    // width x height. A frame with no map uses the map of the nearest frame before it, or the
    // first map: past the ends of the data the picture keeps the nearest correction, and does
    // not jump back.
    setStabilizationTransforms(transforms, width, height) {
        this.setStabilizationData(transforms, {x: 0, y: 0});
        this.stabilizationAffine = {width, height};
        this._affineFrames = [...this.stabilizationData.keys()].sort((p, q) => p - q);
    }

    clearStabilization() {
        this.setStabilizationEnabled(false);
        this.stabilizationData = null;
        this.stabilizationReferencePoint = null;
        this.stabilizationAffine = null;
    }

    affineMapAt(frame) {
        const own = this.stabilizationData.get(frame);
        if (own) return own;
        const frames = this._affineFrames;
        if (!frames?.length) return null;
        if (frame < frames[0]) return this.stabilizationData.get(frames[0]);
        let lo = 0, hi = frames.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (frames[mid] <= frame) lo = mid; else hi = mid - 1;
        }
        return this.stabilizationData.get(frames[lo]);
    }

    // What stabilization does to the picture of `frame`, as a 2D map (applyAffine) in the pixels
    // of a picture width x height, or null when it does nothing. getStabilizedImage() draws
    // with it, and an overlay maps its points with it, so the two cannot disagree.
    stabilizationMatrix(frame, width, height) {
        if (!this.stabilizationEnabled || !this.stabilizationData || !this.stabilizationReferencePoint) return null;
        const f = Math.floor(frame);
        if (this.stabilizationAffine) {
            const m = this.affineMapAt(f);
            if (!m) return null;
            // The same map, for pixels scaled by (sx, sy) from the ones it was made in.
            const sx = width / this.stabilizationAffine.width, sy = height / this.stabilizationAffine.height;
            return {a: m.a, b: m.b * sy / sx, c: m.c * sx / sy, d: m.d, e: m.e * sx, f: m.f * sy};
        }
        const p = interpolatePosition(this.stabilizationData, f);
        if (!p) return null;
        // Tracked positions are in original-video pixels. Direct offsets (motion analysis) are
        // in decoded pixels.
        const baseW = (this.stabilizationDirectOffset ? this.videoWidth : this.originalVideoWidth) || width;
        const baseH = (this.stabilizationDirectOffset ? this.videoHeight : this.originalVideoHeight) || height;
        const sx = width / baseW, sy = height / baseH;
        const r = this.stabilizationReferencePoint;
        const [e, f2] = this.stabilizationDirectOffset ? [p.x * sx, p.y * sy]
            : this.stabilizeCenters ? [width / 2 - p.x * sx, height / 2 - p.y * sy]
            : [r.x * sx - p.x * sx, r.y * sy - p.y * sy];
        return {a: 1, b: 0, c: 0, d: 1, e, f: f2};
    }

    // Changes whenever the shift getImage() applies could change. A filter cache
    // keyed by frame number (Echo) must include it, or after a toggle or a re-track
    // it serves pixels with the old shift. Read from the live fields because some
    // callers write stabilizationEnabled and stabilizeCenters directly.
    getStabilizationKey() {
        if (!this.stabilizationEnabled || !this.stabilizationData || !this.stabilizationReferencePoint) return "off";
        const mode = this.stabilizationAffine ? "affine" : this.stabilizationDirectOffset ? "offset"
            : this.stabilizeCenters ? "center" : "point";
        return `${mode}:${this._stabilizationRevision ?? 0}`;
    }

    // The decoded frame as getImage() shows it, or null if it has not decoded.
    // A class whose getImage() applies stabilization overrides this; here it is
    // the decoder's frame as is.
    getCachedStabilizedImage(frame) {
        return this.getCachedImage?.(frame) ?? null;
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

        // Use source frame's stabilization when using substitute image. The map is made for the
        // size of the image being drawn, which is the decoded size after the videoMaxSize preset,
        // not the original video size.
        const width = originalImage.width || originalImage.videoWidth;
        const height = originalImage.height || originalImage.videoHeight;
        const m = this.stabilizationMatrix(sf, width, height);
        if (!m) {
            return originalImage;
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');

        // Fill with black background
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Draw the moved image. A shift is drawn as it always was; only a map that also rotates
        // or scales (setStabilizationTransforms) needs the full transform.
        if (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1) {
            ctx.drawImage(originalImage, m.e, m.f);
        } else {
            ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
            ctx.drawImage(originalImage, 0, 0);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
        }

        // Only cache if this is the exact frame, not a substitute
        if (isExactFrame) {
            this.stabilizedImageCache[f] = canvas;
            // Evict the oldest. A frame left over from a cleared cache costs only a re-render.
            const order = this._stabilizedCacheOrder ??= [];
            order.push(f);
            if (order.length > STABILIZED_CACHE_FRAMES) delete this.stabilizedImageCache[order.shift()];
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
