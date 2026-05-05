import {CVideoData} from "./CVideoData";
import {assert} from "./assert";

// When true, held frames are returned with a 20px red square in the top-right
// corner so dropped-frame bursts are visually obvious during debugging.
// Flip to false (or wire to a Globals flag) once the patch layer is validated.
const DEBUG_HELD_MARKER = true;

// CVideoPatchedData wraps a source CVideoData (typically CVideoH264Data with
// real PES-PTS chunks) and presents a virtualized timeline whose frame index
// advances at the nominal 1/Sit.fps cadence. Slots that fall inside a
// dropped-frame burst on the source resolve to a held copy of the most recent
// real source frame, so the displayed video freezes through the burst while
// the sitch's frame index — and therefore KLV/RTC pairing — keeps advancing
// at honest wall-clock rate.
//
// See docs/dev/misb-timing.md for the full design and the inversion this
// implements (KLV is no longer retimed; the video is instead).
export class CVideoPatchedData extends CVideoData {
    constructor(source, options = {}) {
        const fps = options.fps;
        assert(fps && fps > 0, "CVideoPatchedData: fps required");
        assert(source && source.framePTSus && source.framePTSus.length > 0,
            "CVideoPatchedData: source must have framePTSus[]");

        const frameDuration_us = 1e6 / fps;
        const halfStep = frameDuration_us / 2;
        const T0 = source.framePTSus[0];
        const TN = source.framePTSus[source.frames - 1];

        const map = [];
        const virtualPTSus = [];
        let S = 0;
        for (let V = 0; ; V++) {
            const targetPTS = T0 + V * frameDuration_us;
            if (targetPTS > TN + halfStep) break;
            while (S + 1 < source.frames &&
                   source.framePTSus[S + 1] <= targetPTS + halfStep) {
                S++;
            }
            map.push(S);
            virtualPTSus.push(targetPTS);
        }
        const virtualFrames = map.length;
        assert(virtualFrames >= source.frames,
            "CVideoPatchedData: virtual count should be >= source count");

        // Synthetic v for base constructor. videoSpeed=1 because any source-side
        // speed scaling has already been applied to source.frames / framePTSus.
        super({
            id: source.id + "_patched",
            frames: virtualFrames,
            videoSpeed: 1,
        });

        this.source = source;
        this.fps = fps;
        this.frameDuration_us = frameDuration_us;
        this.fillMode = options.fillMode || "hold";
        this.map = map;
        this.virtualPTSus = virtualPTSus;
        this.framePTSus = virtualPTSus;
        this.framePTSFromPES = source.framePTSFromPES !== false;

        this.firstVForS = new Array(source.frames);
        for (let V = 0; V < virtualFrames; V++) {
            const s = map[V];
            if (this.firstVForS[s] === undefined) this.firstVForS[s] = V;
        }
        // Defensive backfill — algorithm should leave no holes given monotone
        // PTS, but guard anyway.
        for (let s = 0; s < source.frames; s++) {
            if (this.firstVForS[s] === undefined) {
                this.firstVForS[s] = s > 0 ? this.firstVForS[s - 1] : 0;
            }
        }

        this.videoWidth = source.videoWidth;
        this.videoHeight = source.videoHeight;
        this.originalVideoWidth = source.originalVideoWidth;
        this.originalVideoHeight = source.originalVideoHeight;
        this.metadataRotation = source.metadataRotation || 0;
    }

    // Source <-> virtual frame translation. Persisted frame numbers (saved
    // keyframes, URL ?frame=, MCP set_frame) are source-indexed; runtime
    // playback indices are virtual. These two methods are the boundary.

    sourceToVirtual(S) {
        if (S <= 0) return 0;
        if (S >= this.firstVForS.length) return this.frames - 1;
        return this.firstVForS[S];
    }

    virtualToSource(V) {
        if (V <= 0) return 0;
        if (V >= this.map.length) return this.source.frames - 1;
        return this.map[V];
    }

    // True when V's underlying source frame is the same as V-1's, i.e. a
    // synthesized hold slot. UI uses this to forbid placing manual-tracking
    // keyframes on held frames (option a in the design discussion).
    isHeldFrame(V) {
        if (V <= 0) return false;
        if (V >= this.map.length) return false;
        return this.map[V] === this.map[V - 1];
    }

    getSourceFrame(V) {
        return this.virtualToSource(V);
    }

    // --- frame-data delegation ---

    getImage(frame) {
        const V = Math.floor(frame);
        const S = this.virtualToSource(V);
        const img = this.source.getImage(S);
        if (DEBUG_HELD_MARKER && img && this.isHeldFrame(V)) {
            return this._withHeldMarker(S, img);
        }
        return img;
    }

    // Single-slot cache: held bursts run consecutively over the same source
    // frame, so a 1-entry cache eliminates redraw cost during the burst.
    // Scrubbing across bursts recomputes once per landing, which is fine.
    _withHeldMarker(sourceFrame, img) {
        const w = img.width || img.videoWidth;
        const h = img.height || img.videoHeight;
        if (!w || !h) return img;  // image not yet decoded
        if (this._heldMarkerCache &&
            this._heldMarkerCache.sourceFrame === sourceFrame &&
            this._heldMarkerCache.w === w && this._heldMarkerCache.h === h) {
            return this._heldMarkerCache.canvas;
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const size = 60;
        const margin = 4;
        ctx.fillStyle = 'red';
        ctx.fillRect(w - size - margin, margin, size, size);
        this._heldMarkerCache = {sourceFrame, w, h, canvas};
        return canvas;
    }

    getFrameTimeMs(frame) {
        const V = Math.floor(frame);
        if (V < 0 || V >= this.virtualPTSus.length) return null;
        return (this.virtualPTSus[V] - this.virtualPTSus[0]) / 1000;
    }

    hasRealFramePTS() {
        return this.source.hasRealFramePTS();
    }

    isFrameLoaded(frame) {
        return this.source.isFrameLoaded(this.virtualToSource(frame));
    }

    async waitForFrame(frame, timeout = 5000) {
        return this.source.waitForFrame(this.virtualToSource(frame), timeout);
    }

    update() {
        if (this.source && this.source.update) this.source.update();
    }

    // Stabilization. We canonicalize the lookup key to the first virtual slot
    // for the underlying source frame so a held run reuses one shift instead
    // of interpolating between adjacent non-existent positions (which would
    // produce visible jitter on identical pixels — see review item 4.1).
    setStabilizationData(trackingData, referencePoint, directOffset = false) {
        const canonical = new Map();
        for (const [frame, val] of trackingData) {
            const V = this.sourceToVirtual(this.virtualToSource(Math.floor(frame)));
            canonical.set(V, val);
        }
        super.setStabilizationData(canonical, referencePoint, directOffset);
    }

    getStabilizedImage(frame, originalImage, sourceFrame = undefined) {
        const V = Math.floor(frame);
        const canonical = this.sourceToVirtual(this.virtualToSource(V));
        const sf = sourceFrame !== undefined ? Math.floor(sourceFrame) : canonical;
        return super.getStabilizedImage(frame, originalImage, sf);
    }

    // --- lifecycle ---

    flushEntireCache() {
        // Don't preallocate per-virtual-frame Image() objects — caching lives
        // on source. (Base does this in its constructor before our `source`
        // is assigned, so handle source=undefined.)
        this.imageCache = [];
        this.imageDataCache = [];
        this.frameCache = [];
        this.stabilizedImageCache = [];
        this._heldMarkerCache = null;
        // Source flushing is intentionally NOT propagated here — multiple
        // wrappers could in principle share a source, and source flushing is
        // the caller's responsibility (e.g. via stopStreaming/dispose).
    }

    stopStreaming() {
        this.flushEntireCache();
        if (this.source && this.source.stopStreaming) this.source.stopStreaming();
    }

    dispose() {
        if (this.source && this.source.dispose) this.source.dispose();
        this.source = null;
        this.map = null;
        this.virtualPTSus = null;
        this.framePTSus = null;
        this.firstVForS = null;
        this._heldMarkerCache = null;
        super.dispose();
    }

    // --- diagnostics ---

    getPatchStats() {
        const sourceFrames = this.source ? this.source.frames : 0;
        const heldFrames = this.frames - sourceFrames;
        // Identify each contiguous held run as a "patch": a span of virtual
        // frames [vStart..vEnd] whose underlying source frame is
        // sourceFrame, sandwiched by canonical frames at vStart-1 and
        // vEnd+1. patches[].sourceGap describes the dropped source slots
        // the patch fills (between source frames sourceFrame and
        // sourceFrame+1).
        const patches = [];
        let currentRun = 0;
        for (let V = 1; V < this.map.length; V++) {
            if (this.map[V] === this.map[V - 1]) {
                currentRun++;
            } else {
                if (currentRun > 0) {
                    patches.push({
                        sourceFrame: this.map[V - 1],
                        vStart: V - currentRun,
                        vEnd: V - 1,
                        length: currentRun,
                    });
                }
                currentRun = 0;
            }
        }
        if (currentRun > 0) {
            patches.push({
                sourceFrame: this.map[this.map.length - 1],
                vStart: this.map.length - currentRun,
                vEnd: this.map.length - 1,
                length: currentRun,
            });
        }
        const longestRun = patches.reduce((m, p) => Math.max(m, p.length), 0);
        return {
            sourceFrames,
            virtualFrames: this.frames,
            heldFrames,
            longestHoldFrames: longestRun,
            longestHoldMs: longestRun * 1000 / this.fps,
            fps: this.fps,
            fillMode: this.fillMode,
            patches,
        };
    }

    // Predicate for the wrap decision in CFileManagerParse. Wrap iff the
    // source has real per-frame PTS AND there's at least one interval ≥ 1.9 ×
    // nominal frame duration (a genuine dropped-frame burst — diagnostic
    // 1.5× threshold is too tight for an action gate, see review item 5.1).
    static shouldWrap(source, fps) {
        if (!source || !source.hasRealFramePTS || !source.hasRealFramePTS()) return false;
        if (!source.framePTSus || source.framePTSus.length < 2) return false;
        const frameDuration_us = 1e6 / fps;
        const threshold = 1.9 * frameDuration_us;
        for (let i = 1; i < source.framePTSus.length; i++) {
            const d = source.framePTSus[i] - source.framePTSus[i - 1];
            if (d >= threshold) return true;
        }
        return false;
    }
}
