// Background-motion target tracking.
//
// Tracks a small object that crosses clutter of the same brightness and texture
// — the case where every appearance-based method fails by construction, because
// there is no appearance to key on.
//
// An airborne sensor image holds three classes of content, separated by HOW THEY
// MOVE rather than how they look:
//
//   background   moves as one rigid body, so a single homography maps every
//                background pixel between nearby frames
//   symbology    fixed, or nearly fixed, in SCREEN space, so it does not obey
//                that homography
//   the target   moves against the background AND against the screen
//
// So we fit the background's motion, warp several earlier frames onto the
// current one, and take the per-pixel median as a prediction of what the
// background should look like. Everything obeying the background model cancels;
// what is left is the target. Detection then depends on the target's motion
// relative to the scene, not on its contrast against the scene.
//
// Why a median of many frames rather than a difference against one: differencing
// leaves the target's "ghost" at its old position, and where an extended target
// overlaps its own ghost the difference cancels — so the residual becomes a
// crescent whose centroid is dragged along the direction of travel. The target
// sits somewhere different in each sampled frame, so a median rejects it
// outright and recovers the target's full, unbiased extent.
//
// Why mostly earlier frames: Sitrec's tracking loop runs forward, decoding as it
// goes, so reaching ahead means decoding frames the loop has not got to yet.
// Measured against the symmetric (past-and-future) form on the same clip, a
// past-only window gives the same positional accuracy (0.351 px vs 0.342 px
// scatter about a local quadratic) for a lower detection margin (87 sigma vs
// 141) — plenty of headroom. Near the start of a clip there is no history at
// all, so there the window reaches forward instead; the background model only
// needs the target to be somewhere different in each sample, not for those
// samples to be in the past.
//
// See private/notes/MotionBasedPointTracking.md for the measurements behind each
// of the choices here, and for the failure each one was forced by.

import {MotionTrackPath} from './MotionTrackPath';

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];

export function motionPixelMasked(mask, x, y, width, height) {
    const image = mask?.imageData;
    if (!image) return false;
    const mx = Math.floor(x * image.width / width), my = Math.floor(y * image.height / height);
    if (mx < 0 || my < 0 || mx >= image.width || my >= image.height) return false;
    return image.data[(my * image.width + mx) * 4 + 3] > 128;
}

// One source of truth for the response geometry, so a caller sizing a search
// cannot drift out of step with what measure() actually requires.
const DEFAULTS = {
    gap: 3,
    samples: 8,          // earlier frames in the background window
    gate: 40,            // px from the prediction to search
    targetRadius: 6,     // px; the object's extent, sets the centroid window
    featureScale: 2,     // px; the size of the thing being DETECTED
    context: 24,         // px around the gate, for the noise estimate
    slack: 0,            // px of background displacement to forgive
    polarity: "both",
    registerSize: 720,
    maxFeatures: 800,
    blackLevel: 6,
    border: 10,
    firstFrame: 0,
    lastFrame: Number.MAX_SAFE_INTEGER,
    preferNear: false,   // rank peaks by nearness as well as strength
    requireAppearance: false, // a wide search also needs a real image feature
    maxCandidates: 1,
    fieldSigmas: 8,      // display range of the Motion Field view, in sigma
};

// 3x3 matrix helpers on plain arrays. The matrices here are small and numerous,
// and every cv.Mat has to be deleted by hand, so keeping them out of the OpenCV
// heap removes a whole class of leak.
function mul3(a, b) {
    const out = new Array(9);
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            out[r * 3 + c] = a[r * 3] * b[c] + a[r * 3 + 1] * b[3 + c] + a[r * 3 + 2] * b[6 + c];
        }
    }
    return out;
}

function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (!det || !isFinite(det)) return null;
    const s = 1 / det;
    return [
        A * s, (c * h - b * i) * s, (b * f - c * e) * s,
        B * s, (a * i - c * g) * s, (c * d - a * f) * s,
        C * s, (b * g - a * h) * s, (a * e - b * d) * s,
    ];
}

function translate3(tx, ty) {
    return [1, 0, tx, 0, 1, ty, 0, 0, 1];
}

function apply3(m, x, y) {
    const w = m[6] * x + m[7] * y + m[8];
    if (!w) return null;
    return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
}

// Median of a scratch array's first `n` entries. Insertion sort: n is at most a
// dozen here, and this runs once per pixel, so avoiding allocation matters far
// more than asymptotics.
function medianOf(buf, n) {
    for (let i = 1; i < n; i++) {
        const v = buf[i];
        let j = i - 1;
        while (j >= 0 && buf[j] > v) { buf[j + 1] = buf[j]; j--; }
        buf[j + 1] = v;
    }
    return n & 1 ? buf[(n - 1) >> 1] : 0.5 * (buf[n / 2 - 1] + buf[n / 2]);
}

// Median and a noise sigma from the median absolute deviation. A plain standard
// deviation would be inflated by the target itself and by registration edges;
// the MAD is not, which is what lets one threshold in sigma work across scenes
// as different as a city, a cloud deck and a desert.
function robustScale(values, count) {
    if (count < 8) return {median: 0, sigma: 1};
    const sample = Float32Array.from(values.subarray(0, count));
    sample.sort();
    const median = sample[count >> 1];
    for (let i = 0; i < count; i++) sample[i] = Math.abs(sample[i] - median);
    sample.sort();
    return {median, sigma: Math.max(1.4826 * sample[count >> 1], 0.2)};
}

// Separable maximum (or minimum) filter over a square window. This is what
// buys parallax tolerance: forgiving a local background displacement of up to
// `radius` px means min over |d|<=radius of ( I(x) - W(x+d) ), which is exactly
// I(x) - dilate(W, radius). A misregistered ridge finds a match a pixel away and
// is suppressed; a target that moved 15 px does not, and survives.
function slide(src, dst, w, h, radius, wantMax) {
    const tmp = new Float32Array(w * h);
    const better = wantMax ? (a, b) => (a > b ? a : b) : (a, b) => (a < b ? a : b);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let best = src[y * w + x];
            const lo = Math.max(0, x - radius), hi = Math.min(w - 1, x + radius);
            for (let k = lo; k <= hi; k++) best = better(best, src[y * w + k]);
            tmp[y * w + x] = best;
        }
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let best = tmp[y * w + x];
            const lo = Math.max(0, y - radius), hi = Math.min(h - 1, y + radius);
            for (let k = lo; k <= hi; k++) best = better(best, tmp[k * w + x]);
            dst[y * w + x] = best;
        }
    }
}

export class MotionBackgroundTracker {
    constructor(cv) {
        this.cv = cv;
        this.smallGray = new Map();   // frame -> {mat, scale}  reduced, for registration
        this.step = new Map();        // frame -> 3x3 mapping frame -> frame+1, full-res coords
        this.cameraPath = new MotionTrackPath();
        this.canvas = null;
        this.ctx = null;
        this.lastDiagnostic = null;
    }

    // Drop every cached frame and homography. Must be called whenever the track
    // is cleared or the video changes, or stale homographies from a different
    // clip would be composed into the current one.
    reset() {
        for (const entry of this.smallGray.values()) entry.mat.delete();
        this.smallGray.clear();
        this.step.clear();
        this.cameraPath.clear();
        this.lastDiagnostic = null;
    }

    dispose() {
        this.reset();
        this.canvas = null;
        this.ctx = null;
    }

    syncVideoContext(videoData, opts) {
        const key = [videoData.frameCacheGeneration, videoData.videoWidth, videoData.videoHeight,
            opts.registerSize, opts.maxFeatures, opts.mask?.revision].join(':');
        if (this.cachedVideo !== undefined && (this.cachedVideo !== videoData || this.cachedVideoKey !== key ||
            this.cachedMaskData !== opts.mask?.imageData)) {
            this.reset();
        }
        this.cachedVideo = videoData;
        this.cachedVideoKey = key;
        this.cachedMaskData = opts.mask?.imageData;
    }

    scratch(w, h) {
        if (!this.canvas) {
            this.canvas = document.createElement("canvas");
            this.ctx = this.canvas.getContext("2d", {willReadFrequently: true});
        }
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
        return this.ctx;
    }

    frameImage(videoData, frame) {
        if (frame < 0) return null;
        // Only frames already decoded: the loop runs forward, so recent history
        // is in the cache, but the video may purge distant groups at any time.
        // A missing neighbour is not a problem — the median simply uses fewer
        // samples — so never trigger a decode just to fill the window.
        if (typeof videoData.isFrameLoaded === "function" && !videoData.isFrameLoaded(frame)) return null;
        const img = videoData.getImage(frame);
        if (!img || !(img.width || img.videoWidth)) return null;
        return img;
    }

    // Reduced-resolution grayscale, used only to estimate background motion.
    // Registration does not need full resolution — the homography is scaled back
    // up afterwards — and working small is what keeps this affordable per frame.
    smallGrayOf(videoData, frame, maxSide) {
        const cached = this.smallGray.get(frame);
        if (cached) return cached;
        const img = this.frameImage(videoData, frame);
        if (!img) return null;
        const w = img.width || img.videoWidth;
        const h = img.height || img.videoHeight;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        const sw = Math.max(16, Math.round(w * scale));
        const sh = Math.max(16, Math.round(h * scale));
        const ctx = this.scratch(sw, sh);
        ctx.drawImage(img, 0, 0, w, h, 0, 0, sw, sh);
        const cv = this.cv;
        const rgba = cv.matFromImageData(ctx.getImageData(0, 0, sw, sh));
        const gray = new cv.Mat();
        cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
        rgba.delete();
        const entry = {mat: gray, scale: sw / w, width: sw, height: sh};
        this.smallGray.set(frame, entry);
        return entry;
    }

    // Release frames older than the background window still needs. Every cv.Mat
    // lives in the OpenCV heap and is freed only by hand, so without this the
    // cache grows for the length of the clip — measured at 833 frames and
    // 232 MB on a one-minute test before this was wired up.
    evictBefore(frame) {
        for (const [f, entry] of this.smallGray) {
            if (f < frame) { entry.mat.delete(); this.smallGray.delete(f); }
        }
        for (const f of this.step.keys()) if (f < frame) this.step.delete(f);
    }

    // Homography mapping points in `frame` to points in `frame + 1`, in FULL
    // resolution coordinates.
    stepHomography(videoData, frame, opts) {
        const cached = this.step.get(frame);
        if (cached) return cached;
        const cv = this.cv;
        const a = this.smallGrayOf(videoData, frame, opts.registerSize);
        const b = this.smallGrayOf(videoData, frame + 1, opts.registerSize);
        if (!a || !b) return null;

        let result = null;
        const prev = new cv.Mat(), next = new cv.Mat(), back = new cv.Mat();
        const st1 = new cv.Mat(), st2 = new cv.Mat(), err1 = new cv.Mat(), err2 = new cv.Mat();
        // goodFeaturesToTrack needs a Mat, not null, when there is no mask.
        const mask = this.overlayMask(videoData, frame, a, opts.mask) || new cv.Mat();
        try {
            // qualityLevel is a fraction of the STRONGEST corner anywhere in the
            // image, and the mask filters only the OUTPUT, not that threshold. A
            // black redaction box has by far the hardest corners in a soft scene,
            // so it sets the bar and is then masked away — leaving one or two
            // usable points out of sixty on a cloud background. Step the bar down
            // until enough points survive.
            let found = 0;
            for (const quality of [0.01, 0.003, 0.001, 0.0003, 0.0001]) {
                cv.goodFeaturesToTrack(a.mat, prev, opts.maxFeatures, quality, 8, mask, 7);
                found = prev.rows;
                if (found >= 60) break;
            }
            // Every failure below must fall through to the identity fallback, not
            // return: returning would skip both that fallback and the cache write,
            // leaving a low-texture scene with no homography at all — the caller
            // then finds no usable neighbours and waits forever, and the failed
            // estimation is repeated in full on every subsequent call.
            if (found >= 12) {
                const win = new cv.Size(21, 21);
                const criteria = new cv.TermCriteria(
                    cv.TermCriteria_EPS | cv.TermCriteria_COUNT, 30, 0.01);
                cv.calcOpticalFlowPyrLK(a.mat, b.mat, prev, next, st1, err1, win, 3, criteria);
                // Forward-backward check: a trustworthy correspondence returns to
                // where it started. This is what removes matches on repetitive
                // texture, which RANSAC alone would happily fit into a plausible
                // but wrong homography.
                cv.calcOpticalFlowPyrLK(b.mat, a.mat, next, back, st2, err2, win, 3, criteria);

                const src = [], dst = [];
                for (let i = 0; i < found; i++) {
                    if (!st1.data[i] || !st2.data[i]) continue;
                    const px = prev.data32F[i * 2], py = prev.data32F[i * 2 + 1];
                    const bx = back.data32F[i * 2], by = back.data32F[i * 2 + 1];
                    if (Math.hypot(bx - px, by - py) > 0.5) continue;
                    src.push(px, py);
                    dst.push(next.data32F[i * 2], next.data32F[i * 2 + 1]);
                }
                if (src.length >= 24) {
                    const srcMat = cv.matFromArray(src.length / 2, 1, cv.CV_32FC2, src);
                    const dstMat = cv.matFromArray(dst.length / 2, 1, cv.CV_32FC2, dst);
                    const inliers = new cv.Mat();
                    const H = cv.findHomography(srcMat, dstMat, cv.RANSAC, 1.5,
                        inliers, 2000, 0.995);
                    let count = 0;
                    for (let i = 0; i < inliers.rows; i++) if (inliers.data[i]) count++;
                    if (!H.empty() && count >= 12) {
                        const small = Array.from(H.data64F);
                        // Scale back to full resolution: p_small = S * p_full, so a
                        // homography fitted on the small images becomes S^-1 * H * S.
                        const s = a.scale;
                        const S = [s, 0, 0, 0, s, 0, 0, 0, 1];
                        result = mul3(mul3(inv3(S), small), S);
                        result.inliers = count;
                    }
                    H.delete(); inliers.delete(); srcMat.delete(); dstMat.delete();
                }
            }
        } finally {
            prev.delete(); next.delete(); back.delete();
            st1.delete(); st2.delete(); err1.delete(); err2.delete();
            if (mask) mask.delete();
        }

        if (!result) {
            // A featureless scene is usually also a nearly static one — a sensor
            // locked onto a target against smooth cloud. Assuming no background
            // motion is then very nearly right, and far better than refusing to
            // produce a result at all: the residual still exposes anything that
            // moves relative to the scene.
            result = IDENTITY.slice();
            result.inliers = 0;
        }
        this.step.set(frame, result);
        return result;
    }

    recordCameraMotion(videoData, frame, options) {
        const opts = Object.assign({}, DEFAULTS, options);
        this.syncVideoContext(videoData, opts);
        const last = this.cameraPath.lastFrame ?? frame - 1;
        for (let f = last + 1; f <= frame; f++) {
            this.cameraPath.record(f, this.stepHomography(videoData, f - 1, opts));
        }
        this.evictBefore(frame - opts.gap * opts.samples - 32);
    }

    // Registration must not key on symbology. This mask is built at the reduced
    // registration scale, so it costs little; the response path masks the same
    // content again, per frame, at full resolution.
    overlayMask(videoData, frame, small, userMask) {
        const img = this.frameImage(videoData, frame);
        if (!img) return null;
        const cv = this.cv;
        const {width: w, height: h} = small;
        const ctx = this.scratch(w, h);
        ctx.drawImage(img, 0, 0, img.width || img.videoWidth, img.height || img.videoHeight, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        const mask = new cv.Mat(h, w, cv.CV_8UC1);
        const out = mask.data;
        for (let i = 0, p = 0; i < out.length; i++, p += 4) {
            const r = data[p], g = data[p + 1], b = data[p + 2];
            const hi = r > g ? (r > b ? r : b) : (g > b ? g : b);
            const lo = r < g ? (r < b ? r : b) : (g < b ? g : b);
            // Colour RANGE, not HSV saturation: saturation divides by
            // brightness, so in a blue-tinted image the dark shadows read as
            // fully saturated and half the scene gets excluded.
            out[i] = (hi - lo > 40 || hi < 6 || motionPixelMasked(userMask, i % w, Math.floor(i / w), w, h)) ? 0 : 255;
        }
        return mask;
    }

    // Homography warping `from` into `to`'s geometry, composed from the cached
    // per-frame steps. Composing is far cheaper than re-registering across the
    // gap, and over the few frames used here the accumulated error stays well
    // below the sub-pixel level that matters.
    between(videoData, from, to, opts) {
        if (from === to) return IDENTITY.slice();
        let m = IDENTITY.slice();
        if (from < to) {
            for (let f = from; f < to; f++) {
                const h = this.stepHomography(videoData, f, opts);
                if (!h) return null;
                m = mul3(h, m);
            }
        } else {
            for (let f = from - 1; f >= to; f--) {
                const h = this.stepHomography(videoData, f, opts);
                if (!h) return null;
                const back = inv3(h);
                if (!back) return null;
                m = mul3(back, m);
            }
        }
        return m;
    }

    // Earlier frames to build the background from: `count` of them, spaced
    // `gap` apart, skipping any that are held (a duplicate of its predecessor)
    // or no longer decoded. A held frame carries no evidence at all — the target
    // does not move between a frame and its own copy.
    neighbours(videoData, frame, gap, count, firstFrame, lastFrame) {
        const held = typeof videoData.isHeldFrame === "function"
            ? (f) => videoData.isHeldFrame(f) : () => false;
        const out = [];
        const walk = (step, limit) => {
            let f = frame;
            const reach = gap * count * 3;
            while (out.length < count && Math.abs(f - frame) < reach) {
                f += step * gap;
                while (f !== limit && held(f)) f += step;
                if (step < 0 ? f < firstFrame : f > lastFrame) break;
                // Skip a frame the video has purged rather than stopping at it:
                // one gap in the history should cost one sample, not the whole
                // window.
                if (this.frameImage(videoData, f)) out.push(f);
            }
        };
        walk(-1, firstFrame);
        if (out.length < count) {
            // Near the start of the clip there is no history to build a
            // background from, which would otherwise make the first seconds
            // untrackable. Frames AHEAD serve just as well — the background
            // model only needs the target to be somewhere different in each
            // sample, not for those samples to be in the past. They cost a
            // read-ahead, so they are a fallback rather than the normal path.
            walk(+1, lastFrame);
        }
        return out;
    }

    // Ask the video to decode the frames this method will want. Tracking starts
    // at the seed frame and runs forward, so at that moment there is no history
    // at all — nothing behind the seed has ever been decoded. Requesting them
    // starts that work; it cannot be awaited from inside a synchronous track
    // step, so the caller holds position for the few frames it takes.
    primeHistory(videoData, frame, gap, count, firstFrame, lastFrame) {
        const ask = (f) => {
            if (f < firstFrame || f > lastFrame) return;
            if (typeof videoData.isFrameLoaded === "function" && videoData.isFrameLoaded(f)) return;
            videoData.getImage(f);
        };
        for (let k = 1; k <= count; k++) {
            ask(frame - k * gap);
            if (frame - count * gap < firstFrame) ask(frame + k * gap);
        }
    }

    // Grayscale of the source region that `window` back-projects to, cropped so
    // only the pixels actually needed are read. Returns the crop rectangle so
    // the caller can fold its offset into the warp.
    sourceCrop(videoData, frame, m, window, margin) {
        const img = this.frameImage(videoData, frame);
        if (!img) return null;
        const w = img.width || img.videoWidth;
        const h = img.height || img.videoHeight;
        const back = inv3(m);
        if (!back) return null;
        const {x0, y0, w: ww, h: wh} = window;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [cx, cy] of [[x0, y0], [x0 + ww, y0], [x0, y0 + wh], [x0 + ww, y0 + wh]]) {
            const p = apply3(back, cx, cy);
            if (!p) return null;
            minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
            minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
        }
        const sx = Math.max(0, Math.floor(minX) - margin);
        const sy = Math.max(0, Math.floor(minY) - margin);
        const sw = Math.min(w - sx, Math.ceil(maxX) + margin - sx);
        const sh = Math.min(h - sy, Math.ceil(maxY) + margin - sy);
        if (sw < 4 || sh < 4) return null;
        const ctx = this.scratch(sw, sh);
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        const cv = this.cv;
        const rgba = cv.matFromImageData(ctx.getImageData(0, 0, sw, sh));
        const gray = new cv.Mat();
        cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
        rgba.delete();
        return {mat: gray, sx, sy, sw, sh, sourceWidth: w, sourceHeight: h};
    }

    /**
     * The response over an arbitrary rectangle: this frame minus the background
     * predicted from its neighbours. Shared by the tracker's small search window
     * and by the whole-frame Motion Field view, so what the user is shown is
     * exactly what the detector works from — not a lookalike that could drift
     * out of step with it.
     */
    computeResponse(videoData, frame, rect, opts) {
        const cv = this.cv;
        const img = this.frameImage(videoData, frame);
        if (!img) return null;
        const {x0, y0, w, h} = rect;
        const n = w * h;

        const picked = this.neighbours(videoData, frame, opts.gap, opts.samples,
            opts.firstFrame, opts.lastFrame);
        if (picked.length < 2) {
            // Distinguish "no frames to look at" from "looked and saw nothing":
            // the caller must hold still for the first, not coast.
            this.primeHistory(videoData, frame, opts.gap, opts.samples,
                opts.firstFrame, opts.lastFrame);
            return {waiting: true};
        }

        // Current frame's window, plus the per-frame mask of pixels that carry
        // no evidence. Symbology and redaction do not stay put — a heading
        // letter drifts as the aircraft turns, and redaction boxes are moved to
        // keep covering what they hide — so this is tested per frame, never once.
        const ctx = this.scratch(w, h);
        ctx.drawImage(img, x0, y0, w, h, 0, 0, w, h);
        const cur = ctx.getImageData(0, 0, w, h).data;
        const current = new Float32Array(n);
        const evidence = new Uint8Array(n);
        for (let i = 0, p = 0; i < n; i++, p += 4) {
            const r = cur[p], g = cur[p + 1], b = cur[p + 2];
            const hi = r > g ? (r > b ? r : b) : (g > b ? g : b);
            const lo = r < g ? (r < b ? r : b) : (g < b ? g : b);
            current[i] = 0.299 * r + 0.587 * g + 0.114 * b;
            evidence[i] = (hi - lo > 40 || hi < opts.blackLevel ||
                motionPixelMasked(opts.mask, x0 + i % w, y0 + Math.floor(i / w), img.width, img.height)) ? 0 : 1;
        }

        const stack = [];
        for (const f of picked) {
            const m = this.between(videoData, f, frame, opts);
            if (!m) continue;
            const crop = this.sourceCrop(videoData, f, m, rect, 8 + opts.slack);
            if (!crop) continue;
            // cropped source -> full source -> current frame -> window
            const warpM = mul3(translate3(-x0, -y0), mul3(m, translate3(crop.sx, crop.sy)));
            const warped = new cv.Mat(), covered = new cv.Mat();
            const ones = new cv.Mat(crop.sh, crop.sw, cv.CV_8UC1, new cv.Scalar(255));
            // Excluded pixels in earlier frames must not warp into the current
            // image and masquerade as a dark/bright target beside the mask.
            if (opts.mask) for (let y = 0; y < crop.sh; y++) for (let x = 0; x < crop.sw; x++) {
                if (motionPixelMasked(opts.mask, crop.sx + x, crop.sy + y, crop.sourceWidth, crop.sourceHeight)) {
                    ones.data[y * crop.sw + x] = 0;
                }
            }
            const M = cv.matFromArray(3, 3, cv.CV_64F, warpM);
            const dsize = new cv.Size(w, h);
            try {
                cv.warpPerspective(crop.mat, warped, M, dsize, cv.INTER_CUBIC,
                    cv.BORDER_CONSTANT, new cv.Scalar(0));
                cv.warpPerspective(ones, covered, M, dsize, cv.INTER_NEAREST,
                    cv.BORDER_CONSTANT, new cv.Scalar(0));
                const values = new Float32Array(n);
                const valid = new Uint8Array(n);
                for (let i = 0; i < n; i++) {
                    values[i] = warped.data[i];
                    // A redaction box in an EARLIER frame warps ONTO scene pixels
                    // of this one, where nothing about this frame reveals it.
                    // Black survives warping, so testing the warped value is both
                    // sufficient and cheap.
                    valid[i] = (covered.data[i] === 255 && warped.data[i] >= opts.blackLevel) ? 1 : 0;
                }
                stack.push({values, valid});
            } finally {
                warped.delete(); covered.delete(); ones.delete(); M.delete(); crop.mat.delete();
            }
        }
        if (stack.length < 2) return {waiting: true};

        // Match each warped frame's brightness to the current one before
        // combining. A gain-controlled sensor re-maps brightness every frame,
        // which would otherwise add a varying offset to every residual. Doing it
        // here, locally and in floating point, avoids the clipping and
        // quantisation that a whole-clip 8-bit remap causes — that alone turned
        // a 42-sigma detection into 3.9 on one of the test clips.
        const offsets = new Float32Array(n);
        for (const layer of stack) {
            let count = 0;
            for (let i = 0; i < n; i++) {
                if (layer.valid[i] && evidence[i]) offsets[count++] = current[i] - layer.values[i];
            }
            if (count < 32) continue;
            const shift = robustScale(offsets, count).median;
            for (let i = 0; i < n; i++) layer.values[i] += shift;
        }

        const background = new Float32Array(n);
        const usable = new Uint8Array(n);
        const need = Math.min(3, stack.length);
        const buf = new Float32Array(stack.length);
        for (let i = 0; i < n; i++) {
            let k = 0;
            for (const layer of stack) if (layer.valid[i]) buf[k++] = layer.values[i];
            if (k < need) { usable[i] = 0; continue; }
            background[i] = medianOf(buf, k);
            usable[i] = evidence[i];
        }

        let high = background, low = background;
        if (opts.slack > 0) {
            high = new Float32Array(n);
            low = new Float32Array(n);
            slide(background, high, w, h, opts.slack, true);
            slide(background, low, w, h, opts.slack, false);
        }

        const response = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            if (!usable[i]) { response[i] = 0; continue; }
            const bright = current[i] - high[i];
            const dark = low[i] - current[i];
            response[i] = opts.polarity === "bright" ? bright
                : opts.polarity === "dark" ? dark
                    : Math.max(bright, dark);
        }
        return {response, current, usable, samples: stack.length, x0, y0, w, h};
    }

    /**
     * The whole frame's motion field, as an RGBA image for display.
     *
     * Exactly what the detector sees. Looking at it answers in one glance what
     * no amount of staring at the track can: whether the object stands out at
     * all, whether it is swamped by sensor noise, and whether the thing the
     * tracker chased was a real feature or an artefact. Mid-grey is zero;
     * brightness is scaled by the field's own robust spread, so it reads the
     * same way on a quiet scene and a noisy one, and masked-out pixels are black.
     */
    field(videoData, frame, options) {
        const opts = Object.assign({}, DEFAULTS, options || {});
        this.syncVideoContext(videoData, opts);
        this.evictBefore(frame - opts.gap * opts.samples - 32);
        const img = this.frameImage(videoData, frame);
        if (!img) return null;
        const width = img.width || img.videoWidth;
        const height = img.height || img.videoHeight;
        const b = opts.border;
        const got = this.computeResponse(videoData, frame,
            {x0: b, y0: b, w: width - 2 * b, h: height - 2 * b}, opts);
        if (!got || got.waiting) return null;

        const {response, usable, w, h} = got;
        const n = w * h;
        const pool = new Float32Array(n);
        let count = 0;
        for (let i = 0; i < n; i++) if (usable[i]) pool[count++] = response[i];
        if (count < 64) return null;
        const {median, sigma} = robustScale(pool, count);

        // Show a fixed number of sigma either side of zero, so the picture is a
        // calibrated view in the detector's own units rather than an auto-levelled
        // image that would hide how marginal a peak really is.
        const span = Math.max(1e-6, (opts.fieldSigmas || 8) * sigma);
        const out = new Uint8ClampedArray(n * 4);
        for (let i = 0; i < n; i++) {
            const k = i * 4;
            out[k + 3] = 255;
            if (!usable[i]) continue;                       // masked: black
            const t = (response[i] - median) / span;
            const v = Math.max(0, Math.min(255, Math.round(128 + t * 127)));
            out[k] = v; out[k + 1] = v; out[k + 2] = v;
        }
        return {data: out, width: w, height: h, x0: got.x0, y0: got.y0, sigma};
    }

    /**
     * Strongest motion-inconsistent response within `gate` px of (cx, cy).
     *
     * Returns {x, y, score, samples} in full-resolution image coordinates, or
     * null if nothing there disagrees with the background model. `score` is in
     * units of the response's own robust noise sigma, so a single threshold
     * carries across very different scenes.
     */
    measure(videoData, frame, cx, cy, options) {
        const cv = this.cv;
        const opts = Object.assign({}, DEFAULTS, options || {});
        this.syncVideoContext(videoData, opts);

        const img = this.frameImage(videoData, frame);
        if (!img) return null;
        const width = img.width || img.videoWidth;
        const height = img.height || img.videoHeight;

        // The oldest frame still reachable, with slack for held frames the
        // neighbour walk may have skipped over.
        this.evictBefore(frame - opts.gap * opts.samples - 32);

        const half = Math.round(opts.gate + opts.context);
        const lowest = opts.border;
        // Clip the measurement rectangle on small/low-resolution videos. A
        // large search radius must not disable detection for the whole frame.
        const windowWidth = Math.min(2 * half + 1, width - 2 * lowest);
        const windowHeight = Math.min(2 * half + 1, height - 2 * lowest);
        if (windowWidth < 8 || windowHeight < 8) return null;
        const highestX = width - opts.border - windowWidth;
        const highestY = height - opts.border - windowHeight;
        // Slide the window back inside the frame rather than refusing. The peak
        // search is already restricted to the gate AND to the window, so near an
        // edge this searches a truncated gate — which is much better than never
        // detecting a target that gets close to the edge at all.
        const x0 = Math.min(highestX, Math.max(lowest, Math.round(cx) - half));
        const y0 = Math.min(highestY, Math.max(lowest, Math.round(cy) - half));

        const window = {x0, y0, w: windowWidth, h: windowHeight};
        const got = this.computeResponse(videoData, frame, window, opts);
        if (!got) return null;
        if (got.waiting) return {waiting: true};
        const {response, usable} = got;
        const n = windowWidth * windowHeight;
        let appearance = null;
        if (opts.requireAppearance && got.current) {
            const raw = new Float32Array(n);
            blur(got.current, raw, windowWidth, windowHeight, Math.max(0.6, opts.featureScale));
            appearance = compactImagePeaks(raw, windowWidth, windowHeight, opts.polarity);
            // The residual's centroid can differ slightly from the raw peak,
            // especially on an irregular object. Require nearby corroboration.
            const expanded = new Uint8Array(n);
            for (let y = 2; y < windowHeight - 2; y++) for (let x = 2; x < windowWidth - 2; x++) {
                if (!appearance[y * windowWidth + x]) continue;
                for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
                    expanded[(y + dy) * windowWidth + x + dx] = 1;
                }
            }
            appearance = expanded;
        }

        // ONE detection scale, fixed by the caller. Choosing it per frame — a
        // ladder of scales, best peak wins — sounds better and is not: on some
        // frames a wrong scale wins by chance, and the track fragments. The
        // scale is a property of the clip, so it is measured once by
        // analyseObject() and then committed to, which is both more stable and
        // visible to the user instead of hidden inside the loop.
        const scales = [opts.featureScale];

        const gate2 = opts.gate * opts.gate;
        // Half weight at the edge of the gate. Among comparable candidates the
        // nearest is much the likeliest to be the object, and without that prior
        // a search over a scene containing several genuinely moving things —
        // rotating turbine blades, say — always finds a rival of equal strength
        // somewhere, so the ambiguity check below refuses everything and the
        // track never recovers. It is gentle enough not to block a real jump:
        // a target that jolted to the edge of the gate still wins outright when
        // it is the only strong thing there.
        const nearness = opts.preferNear
            ? (dx, dy) => 1 / (1 + (dx * dx + dy * dy) / gate2)
            : () => 1;

        const smooth = new Float32Array(n);
        const pool = new Float32Array(n);
        let best = null;
        for (const scale of scales) {
            blur(response, smooth, windowWidth, windowHeight, Math.max(0.6, scale));
            let count = 0;
            for (let i = 0; i < n; i++) if (usable[i]) pool[count++] = smooth[i];
            if (count < 64) continue;
            const {median, sigma} = robustScale(pool, count);

            let bestValue = -Infinity, bestIndex = -1, bestRanked = -Infinity;
            for (let y = 0; y < windowHeight; y++) {
                const dy = y0 + y - cy;
                for (let x = 0; x < windowWidth; x++) {
                    const i = y * windowWidth + x;
                    if (!usable[i]) continue;
                    if (appearance && !appearance[i]) continue;
                    const dx = x0 + x - cx;
                    if (dx * dx + dy * dy > gate2) continue;
                    const ranked = (smooth[i] - median) * nearness(dx, dy);
                    if (ranked > bestRanked) {
                        bestRanked = ranked;
                        bestValue = smooth[i];
                        bestIndex = i;
                    }
                }
            }
            if (bestIndex < 0) continue;
            const score = (bestValue - median) / sigma;
            if (!best || score > best.score) {
                best = {scale, score, sigma, median, bestIndex, bestRanked,
                    field: Float32Array.from(smooth)};
            }
        }
        if (!best) return null;

        const {median, sigma, bestIndex, bestRanked, field} = best;
        const px = bestIndex % windowWidth, py = (bestIndex / windowWidth) | 0;

        const centroidRadius = Math.max(2,
            Math.round(Math.min(opts.targetRadius, 3 * best.scale)));
        // Runner-up, outside the detected object's footprint, ranked the same way. An
        // ambiguous gate — two comparable peaks — is how a tracker silently
        // steps onto clutter and never comes back, so the caller is given what
        // it needs to refuse. Using the UI's Track Radius here could exclude
        // the entire search gate around a tiny point, hiding every competitor.
        const keepOut = (3 * centroidRadius) * (3 * centroidRadius);
        let second = -Infinity;
        for (let y = 0; y < windowHeight; y++) {
            const dy = y0 + y - cy;
            for (let x = 0; x < windowWidth; x++) {
                const i = y * windowWidth + x;
                if (!usable[i]) continue;
                if (appearance && !appearance[i]) continue;
                const dx = x0 + x - cx;
                if (dx * dx + dy * dy > gate2) continue;
                const ex = x - px, ey = y - py;
                if (ex * ex + ey * ey <= keepOut) continue;
                const ranked = (field[i] - median) * nearness(dx, dy);
                if (ranked > second) second = ranked;
            }
        }

        // Centre of mass over the object, sized by the scale that actually found
        // it — averaging a 2 px dot's position across 40 px of noise is what
        // pulls a marker off a target it has correctly located.
        const centre = centroid(field, windowWidth, windowHeight, px, py, centroidRadius);
        // score is the winner's own strength, unweighted, so a threshold in
        // sigma means the same thing everywhere. `second` is reported on the
        // same scale but reduced by the RANKED ratio, so the caller's
        // "must beat the runner-up" test compares like with like: a rival that
        // is equally bright but twice as far away is correctly the weaker claim.
        const score = best.score;
        const ratio = (second > 0 && bestRanked > 0) ? second / bestRanked : 0;
        this.lastDiagnostic = {samples: got.samples, sigma, gap: opts.gap, scale: best.scale};
        const result = {
            x: x0 + centre.x,
            y: y0 + centre.y,
            score,
            second: score * ratio,
            scale: best.scale,
            samples: got.samples,
        };
        if (opts.maxCandidates > 1) {
            const peaks = [];
            for (let y = 1; y < windowHeight - 1; y++) for (let x = 1; x < windowWidth - 1; x++) {
                const i = y * windowWidth + x;
                if (!usable[i] || (appearance && !appearance[i])) continue;
                const dx = x0 + x - cx, dy = y0 + y - cy;
                if (dx * dx + dy * dy > gate2) continue;
                const value = field[i];
                if (value < median + 3 * sigma) continue;
                let peak = true;
                for (let yy = -1; yy <= 1 && peak; yy++) for (let xx = -1; xx <= 1; xx++) {
                    if (!xx && !yy) continue;
                    const j = i + yy * windowWidth + xx;
                    if (field[j] > value || (field[j] === value && j < i)) { peak = false; break; }
                }
                if (peak) {
                    // A large search may span quiet sky and highly textured
                    // ground. Judge each candidate against its local background
                    // so clutter elsewhere cannot hide an otherwise clear dot.
                    const radius = Math.ceil(Math.max(12, 6 * best.scale));
                    const local = [];
                    for (let yy = Math.max(0, y - radius); yy <= Math.min(windowHeight - 1, y + radius); yy++) {
                        for (let xx = Math.max(0, x - radius); xx <= Math.min(windowWidth - 1, x + radius); xx++) {
                            if ((xx - x) ** 2 + (yy - y) ** 2 <= centroidRadius ** 2) continue;
                            if (usable[yy * windowWidth + xx]) local.push(field[yy * windowWidth + xx]);
                        }
                    }
                    if (local.length < 32) continue;
                    const noise = robustScale(Float32Array.from(local), local.length);
                    // Local noise can reveal a dot in a quiet part of a busy
                    // frame, but must not disqualify a globally strong target
                    // merely because a nearby edge contaminates its annulus.
                    const score = Math.max((value - median) / sigma,
                        (value - noise.median) / noise.sigma);
                    peaks.push({x, y, score, rank: score * nearness(dx, dy)});
                }
            }
            peaks.sort((a, b) => b.rank - a.rank);
            const selected = [];
            for (const p of peaks) {
                if (selected.some(q => (p.x - q.x) ** 2 + (p.y - q.y) ** 2 < keepOut)) continue;
                selected.push(p);
                if (selected.length >= Math.min(16, opts.maxCandidates)) break;
            }
            result.candidates = selected.map(p => {
                const c = centroid(field, windowWidth, windowHeight, p.x, p.y, centroidRadius);
                return {x: x0 + c.x, y: y0 + c.y, score: p.score, second: 0,
                    scale: best.scale, samples: got.samples};
            });
        }
        return result;
    }
}

// A registration residual can be strong without an object in the raw image
// (particularly beside a white reticle). On a wide reacquisition search require
// a compact raw-image extremum too. This is corroboration, not an appearance
// tracker: normal motion measurements can still cross indistinguishable clutter.
function compactImagePeaks(src, w, h, polarity) {
    const out = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
        const i = y * w + x, v = src[i];
        let high = polarity !== 'dark', low = polarity !== 'bright';
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const a = src[i + dy * w + dx];
            const earlierTie = a === v && (dy < 0 || (dy === 0 && dx < 0));
            if (a > v || earlierTie) high = false;
            if (a < v || earlierTie) low = false;
        }
        if (!high && !low) continue;
        const xx = src[i + 1] - 2 * v + src[i - 1];
        const yy = src[i + w] - 2 * v + src[i - w];
        const xy = (src[i + w + 1] - src[i + w - 1] - src[i - w + 1] + src[i - w - 1]) / 4;
        const det = xx * yy - xy * xy, trace = xx + yy;
        if (det > 0 && trace * trace / det <= 12) out[i] = 1;
    }
    return out;
}

// Intensity-weighted centroid of a peak, above its own local floor. With the
// median background the residual carries the target's full extent, so this
// lands on the target's photometric centre rather than on an edge.
function centroid(src, w, h, px, py, radius) {
    const x0 = Math.max(0, px - radius), x1 = Math.min(w - 1, px + radius);
    const y0 = Math.max(0, py - radius), y1 = Math.min(h - 1, py + radius);
    let floor = Infinity;
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) floor = Math.min(floor, src[y * w + x]);
    let sum = 0, sx = 0, sy = 0;
    for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
            const v = src[y * w + x] - floor;
            if (v <= 0) continue;
            sum += v; sx += v * x; sy += v * y;
        }
    }
    if (sum <= 0) return {x: px, y: py};
    return {x: sx / sum, y: sy / sum};
}

// Separable Gaussian on a Float32Array plane.
function blur(src, dst, w, h, sigma) {
    const radius = Math.max(1, Math.ceil(sigma * 3));
    const size = radius * 2 + 1;
    const kernel = new Float32Array(size);
    let total = 0;
    for (let i = 0; i < size; i++) {
        const x = i - radius;
        kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
        total += kernel[i];
    }
    for (let i = 0; i < size; i++) kernel[i] /= total;
    const tmp = new Float32Array(w * h);
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let v = 0;
            for (let k = -radius; k <= radius; k++) {
                const xx = Math.min(w - 1, Math.max(0, x + k));
                v += src[y * w + xx] * kernel[k + radius];
            }
            tmp[y * w + x] = v;
        }
    }
    for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
            let v = 0;
            for (let k = -radius; k <= radius; k++) {
                const yy = Math.min(h - 1, Math.max(0, y + k));
                v += tmp[yy * w + x] * kernel[k + radius];
            }
            dst[y * w + x] = v;
        }
    }
}
