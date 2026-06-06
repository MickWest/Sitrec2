/**
 * Feature-based panorama exporter — "Export Feature Pano Image / Video".
 *
 * A separate, more capable panorama path than "Export Motion Panorama". The
 * Motion Panorama pastes each video frame with only a 2D translation (+ optional
 * whole-image rotation); this path registers frames with industry-standard
 * feature matching and warps them to fit.
 *
 * Pipeline (entirely on the actual video frames):
 *   1. ORB feature detection + 256-bit BRIEF descriptors per frame.
 *   2. BFMatcher Hamming knn + Lowe ratio test (0.75).
 *   3. cv.findHomography(RANSAC) per adjacent pair, plus a robust RIGID
 *      (rotation + translation) fit on its inliers.
 *   4. Compose into a common frame, anchored at the MIDDLE frame.
 *   5. Pick the model: a full-homography PLANAR mosaic captures perspective
 *      (great for translating/aerial captures) but explodes when the chain
 *      drifts or the rotation is large (→ black). Detected by comparing the
 *      planar bbox to the drift-proof RIGID bbox; on blow-up we use the RIGID
 *      chain (correct flat/cylindrical unrolling for a rotating camera, no focal
 *      length needed).
 *   6a. Image: warpPerspective every frame onto the panorama + feather-blend → PNG.
 *   6b. Video: build that panorama as a static background, then render an MP4
 *       where each source frame is warped (by the SAME transform that stitched
 *       it) into its place on the panorama — so the live frame conforms to and
 *       moves across the feature-stitched background.
 *
 * A full-screen overlay shows progress, refreshing the intermediate image on a
 * ~3 second wall-clock cadence (the current frame during registration, the
 * building panorama / video composite during rendering).
 *
 * Burned-in HUD / redaction graphics are STATIC in image space, so the redaction
 * mask (+ crop ring) is used as the ORB *detection* mask. OpenCV.js Mat lifecycle
 * is freed per-iteration via try/finally and long-lived objects in the outer
 * finally on every path.
 */

import {GlobalDateTimeNode, Globals, setRenderOne, Sit} from "./Globals";
import {par} from "./par";
import {getExportPrefix} from "./utils";

const MAX_PANORAMA_DIM = 16384;
const MAX_PANORAMA_AREA = 128 * 1024 * 1024;
const PANO_VIDEO_MAX_W = 3840;
const PANO_VIDEO_MAX_H = 2160;
const PREVIEW_INTERVAL_MS = 3000;       // wall-clock cadence for intermediate-image preview

const DEFAULT_FEATURE_COUNT = 2000;
const DEFAULT_FAST_THRESHOLD = 20;      // ORB FAST corner-contrast threshold; lower = fainter features
const DEFAULT_DETECT_SCALE = 1;         // detect features at 1/N resolution; higher = larger/blurrier features
const MIN_TRACKLET_LEN = 3;             // a feature must appear in >= this many consecutive frames to be trusted
const TRACKLET_COHERENCE_TOL = 3;       // px: max deviation of a step from the tracklet's median step
const RATIO_TEST = 0.75;
const RANSAC_REPROJ = 3.0;
const MIN_GOOD_MATCHES = 12;
const MIN_INLIERS = 10;
const MIN_INLIER_RATIO = 0.25;
const PLANAR_BLOWUP_AREA = 50;          // per-frame projected-area stretch that means "use rigid"

function panoFitScale(width, height) {
    let scale = 1;
    scale = Math.min(scale, MAX_PANORAMA_DIM / width);
    scale = Math.min(scale, MAX_PANORAMA_DIM / height);
    const area = width * height;
    if (area > MAX_PANORAMA_AREA) {
        scale = Math.min(scale, Math.sqrt(MAX_PANORAMA_AREA / area));
    }
    return scale;
}

// ---- 3x3 transform helpers (row-major [a,b,c, d,e,f, g,h,i]) -------------

const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function mat3mul(A, B) {
    const C = new Array(9);
    for (let r = 0; r < 3; r++) {
        for (let c = 0; c < 3; c++) {
            C[r * 3 + c] = A[r * 3] * B[c] + A[r * 3 + 1] * B[3 + c] + A[r * 3 + 2] * B[6 + c];
        }
    }
    return C;
}

function mat3inv(M) {
    const [a, b, c, d, e, f, g, h, i] = M;
    const A = e * i - f * h;
    const B = c * h - b * i;
    const C = b * f - c * e;
    const D = f * g - d * i;
    const E = a * i - c * g;
    const F = c * d - a * f;
    const G = d * h - e * g;
    const H = b * g - a * h;
    const I = a * e - b * d;
    const det = a * A + b * D + c * G;
    if (!isFinite(det) || Math.abs(det) < 1e-18) return null;
    const s = 1 / det;
    return [A * s, B * s, C * s, D * s, E * s, F * s, G * s, H * s, I * s];
}

function applyH(H, x, y) {
    const w = H[6] * x + H[7] * y + H[8];
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
}

function translate3(tx, ty) {
    return [1, 0, tx, 0, 1, ty, 0, 0, 1];
}

// Best-fit RIGID transform (rotation + translation, scale=1) mapping `cur` -> `prev`
// (Umeyama, scale=1), optionally over an inlier mask. No perspective DOF, so a
// chain of these can never blow up — the key robustness property for rotating cams.
function rigidFromMatches(curPts, prevPts, mask) {
    const N = curPts.length / 2;
    let cxc = 0, cyc = 0, cpx = 0, cpy = 0, cnt = 0;
    for (let k = 0; k < N; k++) {
        if (mask && !mask[k]) continue;
        cxc += curPts[2*k]; cyc += curPts[2*k+1];
        cpx += prevPts[2*k]; cpy += prevPts[2*k+1];
        cnt++;
    }
    if (cnt < 2) return null;
    cxc /= cnt; cyc /= cnt; cpx /= cnt; cpy /= cnt;
    let sdot = 0, scross = 0;
    for (let k = 0; k < N; k++) {
        if (mask && !mask[k]) continue;
        const ax = curPts[2*k] - cxc, ay = curPts[2*k+1] - cyc;
        const bx = prevPts[2*k] - cpx, by = prevPts[2*k+1] - cpy;
        sdot += ax*bx + ay*by;
        scross += ax*by - ay*bx;
    }
    const theta = Math.atan2(scross, sdot);
    const c = Math.cos(theta), s = Math.sin(theta);
    const tx = cpx - (c * cxc - s * cyc);
    const ty = cpy - (s * cxc + c * cyc);
    return [c, -s, tx, s, c, ty, 0, 0, 1];
}

// ---- feature detection ---------------------------------------------------

// Build an ORB detector tuned for the content. We configure it with the SETTER
// methods rather than the positional constructor: this OpenCV.js (WASM) build
// can't bind the ORB::ScoreType enum, so the multi-arg `new cv.ORB(...)` form
// THROWS ("unbound types ... ScoreType"), which silently defeated any attempt to
// pass a custom FAST threshold. The setters (setFastThreshold / setEdgeThreshold
// / setPatchSize) work fine.
//
// fastThreshold is the key low-contrast knob: lower it to pick up faint cloud
// edges. detectDim (the smallest dimension at which detection actually runs, i.e.
// after any Feature-Scale downscale) lets us shrink edgeThreshold/patchSize so
// they still fit a small image — the 31px defaults exceed a heavily downscaled
// frame and would find nothing.
function makeORB(cv, featureCount, fastThreshold, detectDim) {
    const orb = new cv.ORB(Math.max(1, Math.round(featureCount)));
    try { orb.setFastThreshold(Math.max(1, Math.round(fastThreshold))); } catch (_) { /* binding lacks setter */ }
    if (detectDim && detectDim > 0) {
        // Keep the ignored border a small, roughly constant FRACTION (~8%) of the
        // detection image rather than the 31px default. At high Feature Scale the
        // downscaled frame is small, and a 31px border would confine detection to
        // the CENTRE — re-introducing the masked HUD/object and dropping the edge
        // clouds (the bug that made Feature Scale > 1 cluster everything mid-frame
        // and kept the optimizer pinned at scale 1). patchSize tracks edgeThreshold.
        const edge = Math.max(8, Math.min(31, Math.round(detectDim / 12)));
        try { orb.setEdgeThreshold(edge); } catch (_) { /* ignore */ }
        try { orb.setPatchSize(edge); } catch (_) { /* ignore */ }
    }
    return orb;
}

// Detect ORB features on a gray Mat, optionally at a reduced resolution.
// detectScale>1 downsamples with INTER_AREA (a low-pass average) BEFORE detection,
// so large soft structures (e.g. clouds) become sharp corners and pixel noise is
// washed out — the key knob for low-frequency content. Keypoints are scaled back
// to FULL-resolution coordinates so all downstream geometry stays in source pixels.
// Descriptors are computed at the detection scale; both frames in a pair share the
// same scale, so they remain comparable. Returns {kp, des}; the CALLER owns des.
function detectFeatures(cv, orb, gray, detectMask, noMask, detectScale) {
    const s = Math.max(1, Math.round(detectScale || 1));
    let small = null, smallMask = null;
    let scaledGray = gray, scaledMask = detectMask;
    let sx = 1, sy = 1;
    try {
        if (s > 1) {
            const dw = Math.max(1, Math.round(gray.cols / s));
            const dh = Math.max(1, Math.round(gray.rows / s));
            small = new cv.Mat();
            cv.resize(gray, small, new cv.Size(dw, dh), 0, 0, cv.INTER_AREA);
            scaledGray = small;
            sx = gray.cols / dw;
            sy = gray.rows / dh;
            if (detectMask && detectMask.rows) {
                smallMask = new cv.Mat();
                cv.resize(detectMask, smallMask, new cv.Size(dw, dh), 0, 0, cv.INTER_NEAREST);
                scaledMask = smallMask;
            }
        }
        const kpVec = new cv.KeyPointVector();
        const des = new cv.Mat();
        try {
            orb.detectAndCompute(scaledGray, scaledMask || noMask, kpVec, des);
            const kp = new Array(kpVec.size());
            for (let k = 0; k < kpVec.size(); k++) {
                const p = kpVec.get(k).pt;
                kp[k] = {x: p.x * sx, y: p.y * sy};
            }
            return {kp, des};
        } catch (e) {
            des.delete();
            throw e;
        } finally {
            kpVec.delete();
        }
    } finally {
        if (small) small.delete();
        if (smallMask) smallMask.delete();
    }
}

// Build the ORB detection mask (CV_8UC1, 255 = detect here, 0 = ignore): the outer
// `crop`-px ring plus any redaction-mask pixels are zeroed. Returns null when no
// masking is needed. Caller owns the returned Mat.
function buildDetectMask(cv, W, H, crop, useMask, maskImageData) {
    if (!useMask && crop <= 0) return null;
    const detectMask = cv.Mat.ones(H, W, cv.CV_8UC1);
    detectMask.setTo(new cv.Scalar(255));
    const md = detectMask.data;
    const maskPix = useMask ? maskImageData.data : null;
    const maskW = useMask ? maskImageData.width : W;
    const maskH = useMask ? maskImageData.height : H;
    const xHi = W - crop, yHi = H - crop;
    for (let y = 0; y < H; y++) {
        const inCropY = y < crop || y >= yHi;
        for (let x = 0; x < W; x++) {
            let masked = inCropY || x < crop || x >= xHi;
            if (!masked && maskPix && x < maskW && y < maskH) {
                if (maskPix[(y * maskW + x) * 4 + 3] > 128) masked = true;
            }
            if (masked) md[y * W + x] = 0;
        }
    }
    return detectMask;
}

// ---- per-frame image access ---------------------------------------------

async function loadVideoFrame(videoData, frame) {
    par.frame = frame;
    GlobalDateTimeNode?.update(frame);
    videoData.getImage(frame);
    const ok = await videoData.waitForFrame(frame, 5000);
    if (!ok) return null;
    const image = (videoData.getImageNoPurge?.(frame)) || videoData.getImage(frame);
    if (!image || !image.width) return null;
    return image;
}

// Decode a frame into an RGBA cv.Mat with the feather/mask baked into its alpha.
async function decodeFeatherSrc(cv, videoData, frame, W, H, frameCtx, featherAlpha) {
    const image = await loadVideoFrame(videoData, frame);
    if (!image) return null;
    frameCtx.clearRect(0, 0, W, H);
    frameCtx.drawImage(image, 0, 0, W, H);
    const id = frameCtx.getImageData(0, 0, W, H);
    const data = id.data;
    for (let p = 0; p < W * H; p++) data[p * 4 + 3] = featherAlpha[p];
    return cv.matFromImageData(id);
}

// Composite a warped RGBA tile (CV_8UC4) onto a 2D context with source-over.
function compositeTile(ctx, tileCanvas, tileCtx, dst, rx, ry, rw, rh) {
    const tileImg = new ImageData(new Uint8ClampedArray(dst.data), rw, rh);
    tileCanvas.width = rw;
    tileCanvas.height = rh;
    tileCtx.putImageData(tileImg, 0, 0);
    ctx.drawImage(tileCanvas, rx, ry);
}

// Warp source frame i (a feathered RGBA cv.Mat) through transform Fi and draw it
// onto ctx (whose coordinate space Fi maps into). Bounds-clamped tile warp.
function warpFrameOnto(cv, src, Fi, ctx, tileCanvas, tileCtx, outW, outH, corners) {
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const [cx, cy] of corners) {
        const [px, py] = applyH(Fi, cx, cy);
        if (!isFinite(px) || !isFinite(py)) return false;
        if (px < bx0) bx0 = px; if (px > bx1) bx1 = px;
        if (py < by0) by0 = py; if (py > by1) by1 = py;
    }
    const rx = Math.max(0, Math.floor(bx0));
    const ry = Math.max(0, Math.floor(by0));
    const rw = Math.min(outW, Math.ceil(bx1)) - rx;
    const rh = Math.min(outH, Math.ceil(by1)) - ry;
    if (rw <= 0 || rh <= 0) return false;
    let dst = null, Hm = null;
    try {
        dst = new cv.Mat();
        Hm = cv.matFromArray(3, 3, cv.CV_64F, mat3mul(translate3(-rx, -ry), Fi));
        cv.warpPerspective(src, dst, Hm, new cv.Size(rw, rh),
            cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
        compositeTile(ctx, tileCanvas, tileCtx, dst, rx, ry, rw, rh);
    } finally {
        if (dst) dst.delete();
        if (Hm) Hm.delete();
    }
    return true;
}

// Draw the current video frame to the preview canvas with its matched features
// circled — the live "detecting & matching features" visualization.
function drawFeaturePreview(ctx, canvas, image, matched, W, H) {
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const sx = canvas.width / W, sy = canvas.height / H;
    const r = Math.max(3, Math.round(canvas.width / 220) + 2);
    if (matched && matched.length) {
        ctx.strokeStyle = 'rgba(0, 255, 120, 0.9)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        for (const p of matched) {
            const x = p.x * sx, y = p.y * sy;
            ctx.moveTo(x + r, y);
            ctx.arc(x, y, r, 0, 2 * Math.PI);
        }
        ctx.stroke();
    }
    ctx.fillStyle = 'rgba(0, 255, 120, 0.95)';
    ctx.font = '16px sans-serif';
    ctx.fillText(`${matched ? matched.length : 0} matched features`, 8, 22);
}

// Stroke the outline of a frame's warped quad (its 4 corners through Fi), to
// show where the current frame sits on the panorama background.
function drawQuadOutline(ctx, Fi, corners) {
    const pts = corners.map(([x, y]) => applyH(Fi, x, y));
    for (const p of pts) if (!isFinite(p[0]) || !isFinite(p[1])) return;
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 255, 255, 0.85)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
}

// Compose per-pair transforms M[i] (frame i -> i-1) into global transforms
// G[i] (frame i -> anchor), anchored at the middle frame.
function composeChain(M, n, anchor) {
    const G = new Array(n).fill(null);
    G[anchor] = IDENTITY3.slice();
    for (let i = anchor + 1; i < n; i++) {
        G[i] = mat3mul(G[i - 1], M[i] || IDENTITY3.slice());
    }
    for (let i = anchor - 1; i >= 0; i--) {
        const inv = mat3inv(M[i + 1] || IDENTITY3.slice());
        G[i] = mat3mul(G[i + 1], inv || IDENTITY3.slice());
    }
    return G;
}

// Bounding box + worst per-frame projected-area stretch + non-finite flag.
function bboxOf(G, n, W, H) {
    const srcArea = W * H;
    const corners = [[0, 0], [W, 0], [W, H], [0, H]];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    let maxStretch = 0, bad = false;
    for (let i = 0; i < n; i++) {
        const c = corners.map(([x, y]) => applyH(G[i], x, y));
        let ok = true;
        for (const p of c) if (!isFinite(p[0]) || !isFinite(p[1])) { ok = false; break; }
        if (!ok) { bad = true; continue; }
        for (const p of c) {
            if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
            if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
        }
        const a = Math.abs(
            c[0][0]*c[1][1] - c[1][0]*c[0][1] +
            c[1][0]*c[2][1] - c[2][0]*c[1][1] +
            c[2][0]*c[3][1] - c[3][0]*c[2][1] +
            c[3][0]*c[0][1] - c[0][0]*c[3][1]) / 2;
        if (a / srcArea > maxStretch) maxStretch = a / srcArea;
    }
    const area = (isFinite(minX) && maxX > minX && maxY > minY) ? (maxX - minX) * (maxY - minY) : Infinity;
    return {minX, minY, maxX, maxY, area, maxStretch, bad};
}

// ---- core (shared by image + video) -------------------------------------

/**
 * @param {object} o   see exportFeaturePanorama / exportFeaturePanoramaVideo
 * @param {"image"|"video"} mode
 */
async function runFeaturePano(o, mode) {
    const cv = o.cv;
    const videoData = o.videoData;
    const startFrame = o.startFrame;
    const endFrame = o.endFrame;
    const frameStep = Math.max(1, Math.round(o.frameStep || 1));
    const crop = Math.max(0, Math.round(o.crop || 0));
    const useMask = !!o.useMask && !!o.maskImageData;
    const maskImageData = o.maskImageData || null;
    const featureCount = o.featureCount || DEFAULT_FEATURE_COUNT;
    const fastThreshold = o.fastThreshold || DEFAULT_FAST_THRESHOLD;
    const detectScale = Math.max(1, Math.round(o.detectScale || DEFAULT_DETECT_SCALE));
    const projection = o.projection || "auto";
    const t = o.t || ((k) => k);
    const setMenuLabel = o.setMenuLabel || (() => {});
    const doneLabel = o.doneLabel || null;
    const externalCancel = typeof o.shouldCancel === "function" ? o.shouldCancel : () => false;
    // "Motion Tracklets" source: when provided, registration uses the existing
    // MotionAnalyzer optical-flow tracklets (getCorrespondences(frame) -> {curPts,
    // prevPts} for the prev->frame step) instead of detecting/matching ORB features.
    // Those tracks follow the SAME points across many frames (consistent), unlike
    // ORB which re-detects a fresh set of corners on soft clouds each frame.
    const getCorrespondences = typeof o.getCorrespondences === "function" ? o.getCorrespondences : null;
    const motionMode = !!getCorrespondences;

    if (!cv || !cv.Mat) { alert("OpenCV not available for feature panorama"); return; }
    if (endFrame <= startFrame) { alert("Select a frame range (A-B) before exporting a feature panorama"); return; }

    const frames = [];
    for (let f = startFrame; f <= endFrame; f += frameStep) frames.push(f);
    const n = frames.length;
    if (n < 2) { alert("Need at least two frames for a panorama"); return; }

    const savedPaused = par.paused;
    const savedFrame = par.frame;
    const savedJustVideoAnalysis = Globals.justVideoAnalysis;
    Globals.justVideoAnalysis = true;
    par.paused = true;

    let overlay = null;
    const persistent = [];
    let prevDes = null;
    let weakLinks = 0;
    let cancelled = false;
    // Cancelled either by the overlay's own Cancel button (local `cancelled`) or
    // by the external "Stop Analysis" menu signal threaded in via o.shouldCancel.
    const isCancelled = () => cancelled || externalCancel();
    let lastPreview = 0;

    try {
        const firstImage = await loadVideoFrame(videoData, frames[0]);
        if (!firstImage) { alert("Could not load the first video frame"); return; }
        const W = firstImage.width;
        const H = firstImage.height;
        const corners = [[0, 0], [W, 0], [W, H], [0, H]];

        // ---- full-screen progress overlay ----
        overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:#000;z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;';
        const previewCanvas = document.createElement('canvas');
        previewCanvas.style.cssText = 'max-width:95vw;max-height:80vh;border:2px solid #444;background:#111;';
        previewCanvas.width = Math.min(W, 1280);
        previewCanvas.height = Math.round(previewCanvas.width * H / W);
        const previewCtx = previewCanvas.getContext('2d');
        const statusText = document.createElement('div');
        statusText.style.cssText = 'color:#fff;font-size:18px;margin-top:15px;font-family:sans-serif;';
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'margin-top:14px;padding:6px 18px;font-size:15px;cursor:pointer;';
        cancelBtn.onclick = () => { cancelled = true; cancelBtn.disabled = true; cancelBtn.textContent = 'Cancelling…'; };
        overlay.appendChild(previewCanvas);
        overlay.appendChild(statusText);
        overlay.appendChild(cancelBtn);
        document.body.appendChild(overlay);
        const setStatus = (s) => { statusText.textContent = s; };

        // Refresh the intermediate image at most every PREVIEW_INTERVAL_MS.
        const showPreview = (drawFn) => {
            const now = performance.now();
            if (now - lastPreview >= PREVIEW_INTERVAL_MS) { lastPreview = now; try { drawFn(); } catch (_) { /* ignore */ } }
        };
        const fitPreview = (w, h) => {
            previewCanvas.width = Math.min(1600, w);
            previewCanvas.height = Math.max(1, Math.round(previewCanvas.width * h / w));
        };

        const frameCanvas = document.createElement('canvas');
        frameCanvas.width = W;
        frameCanvas.height = H;
        const frameCtx = frameCanvas.getContext('2d', {willReadFrequently: true});

        // Per-frame feather/mask alpha.
        const featherPx = Math.max(16, Math.round(0.06 * Math.min(W, H)));
        const featherAlpha = new Uint8ClampedArray(W * H);
        {
            const maskPix = useMask ? maskImageData.data : null;
            const maskW = useMask ? maskImageData.width : W;
            const maskH = useMask ? maskImageData.height : H;
            const xHi = W - crop, yHi = H - crop;
            for (let y = 0; y < H; y++) {
                for (let x = 0; x < W; x++) {
                    let a = 0;
                    const inCrop = x < crop || x >= xHi || y < crop || y >= yHi;
                    if (!inCrop) {
                        const edge = Math.min(x - crop, (xHi - 1) - x, y - crop, (yHi - 1) - y);
                        a = Math.max(0, Math.min(1, (edge + 1) / featherPx));
                    }
                    if (a > 0 && maskPix && x < maskW && y < maskH) {
                        if (maskPix[(y * maskW + x) * 4 + 3] > 128) a = 0;
                    }
                    featherAlpha[y * W + x] = Math.round(a * 255);
                }
            }
        }

        // ORB feature detection + matching is only needed for the ORB source; the
        // Motion-Tracklets source pulls correspondences straight from the analyzer.
        let detectMask = null, noMask = null, orb = null, bf = null;
        if (!motionMode) {
            detectMask = buildDetectMask(cv, W, H, crop, useMask, maskImageData);
            if (detectMask) persistent.push(detectMask);
            noMask = new cv.Mat();
            persistent.push(noMask);
            orb = makeORB(cv, featureCount, fastThreshold, Math.min(W, H) / detectScale);
            persistent.push(orb);
            bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
            persistent.push(bf);
        }

        // ===== PASS 1: per-adjacent-pair transforms Mh[i] (homography) / Mr[i] (rigid) =====
        const Mh = new Array(n).fill(null);
        const Mr = new Array(n).fill(null);

        if (motionMode) {
            // ---- Source: existing MotionAnalyzer optical-flow tracklets ----
            // For each pano step, compose the single-frame fits across the spanned
            // video frames (handles frameStep > 1). Each frame's correspondences come
            // straight from the analyzer's coherent tracklets, so no detection/matching
            // is needed here — and no per-frame image decode (PASS 2 reloads for warping).
            for (let i = 1; i < n; i++) {
                if (isCancelled()) throw new Error("cancelled");
                let Hstep = IDENTITY3.slice();
                let Rstep = IDENTITY3.slice();
                let stepWeak = false;
                const lo = frameStep === 1 ? frames[i] : frames[i] - frameStep + 1;
                for (let f = lo; f <= frames[i]; f++) {
                    const corr = getCorrespondences(f);
                    const res = (corr && corr.curPts.length >= 2)
                        ? fitFromCorrespondences(cv, corr.curPts, corr.prevPts)
                        : {H: IDENTITY3.slice(), rigid: IDENTITY3.slice(), weak: true};
                    if (res.weak) stepWeak = true;
                    Hstep = mat3mul(Hstep, res.H);
                    Rstep = mat3mul(Rstep, res.rigid);
                }
                if (stepWeak) weakLinks++;
                Mh[i] = Hstep;
                Mr[i] = Rstep;

                if (i % 8 === 0) {
                    setMenuLabel("status.analyzingPercent", {pct: Math.round(100 * (i + 1) / n)});
                    setStatus(t("status.detectingFeaturesPercent", {pct: Math.round(100 * (i + 1) / n)}));
                    await new Promise(r => setTimeout(r, 0));
                }
            }
            console.log(`Feature Panorama (motion tracklets): ${n} frames, ${weakLinks} weak link(s)`);
        } else {
            // ---- Source: ORB features + multi-frame tracklets ----
            // Independent frame-to-frame matching floods low-contrast / noisy footage
            // with false positives (sensor noise, one-off mismatches). Instead we chain
            // mutually-consistent matches into tracks spanning the whole sequence and keep
            // only features that PERSIST (>= minTrackLen frames) and move COHERENTLY
            // (near-constant per-step velocity). Noise can do neither, so it is filtered
            // out before it ever reaches the transform fit.
            const minTrackLen = Math.max(2, Math.min(MIN_TRACKLET_LEN, n));
            const tracker = makeTracker(minTrackLen);
            let lastMatched = null;   // persistent tracked points on the most recent frame (preview)

            for (let i = 0; i < n; i++) {
                if (isCancelled()) throw new Error("cancelled");
                const frame = frames[i];
                setStatus(t("status.loadingFrame", {frame, current: i + 1, total: n}));

                const image = await loadVideoFrame(videoData, frame);
                if (!image) {
                    // A missing frame breaks track continuity; the next frame restarts chains.
                    if (prevDes) { prevDes.delete(); prevDes = null; }
                    continue;
                }
                frameCtx.clearRect(0, 0, W, H);
                frameCtx.drawImage(image, 0, 0, W, H);
                const id = frameCtx.getImageData(0, 0, W, H);

                let src = null, gray = null, det = null;
                try {
                    src = cv.matFromImageData(id);
                    gray = new cv.Mat();
                    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
                    src.delete(); src = null;

                    det = detectFeatures(cv, orb, gray, detectMask, noMask, detectScale);
                    gray.delete(); gray = null;

                    const pairs = prevDes ? matchMutual(cv, bf, prevDes, det.des) : null;
                    tracker.addFrame(i, det.kp, pairs);
                    lastMatched = tracker.activePersistent(minTrackLen);

                    if (prevDes) prevDes.delete();
                    prevDes = det.des;
                    det = null;
                } finally {
                    if (src) src.delete();
                    if (gray) gray.delete();
                    if (det && det.des) det.des.delete();
                }

                if (i % 4 === 0) {
                    setMenuLabel("status.analyzingPercent", {pct: Math.round(100 * (i + 1) / n)});
                    setStatus(t("status.detectingFeaturesPercent", {pct: Math.round(100 * (i + 1) / n)}));
                    drawFeaturePreview(previewCtx, previewCanvas, image, lastMatched, W, H);
                    await new Promise(r => setTimeout(r, 0));
                }
            }
            if (prevDes) { prevDes.delete(); prevDes = null; }

            // Filter tracklets, then fit each pair from the clean correspondences.
            const allTracks = tracker.finish();   // already length-filtered (>= minTrackLen)
            const survivors = allTracks.filter(tr => trackIsCoherent(tr, TRACKLET_COHERENCE_TOL));
            const {cur: pairCur, prev: pairPrev} = pairCorrespondences(survivors, n);
            for (let i = 1; i < n; i++) {
                const res = fitFromCorrespondences(cv, pairCur[i] || [], pairPrev[i] || []);
                if (res.weak) weakLinks++;
                Mh[i] = res.H;
                Mr[i] = res.rigid;
            }
            console.log(`Feature Panorama tracklets: ${allTracks.length} persistent (>=${minTrackLen}f) → ${survivors.length} coherent`);
        }

        // ===== choose the model & compose the global transform chain =====
        const anchor = Math.floor(n / 2);
        const Gh = composeChain(Mh, n, anchor);
        const Gr = composeChain(Mr, n, anchor);
        const bh = bboxOf(Gh, n, W, H);
        const br = bboxOf(Gr, n, W, H);

        let useRigid;
        if (projection === "planar") useRigid = false;
        else if (projection === "rigid") useRigid = true;
        else {
            const planarBad = bh.bad || !isFinite(bh.area) || bh.area <= 0;
            useRigid = planarBad
                || bh.maxStretch > PLANAR_BLOWUP_AREA
                || (isFinite(br.area) && br.area > 0 && bh.area > 4 * br.area);
        }
        const G = useRigid ? Gr : Gh;
        const bb = useRigid ? br : bh;

        if (bb.bad || !isFinite(bb.area) || bb.maxX <= bb.minX || bb.maxY <= bb.minY) {
            throw new Error("registration produced a degenerate panorama");
        }
        const {minX, minY, maxX, maxY} = bb;
        const scale = panoFitScale(Math.ceil(maxX - minX), Math.ceil(maxY - minY));
        const outW = Math.max(1, Math.floor((maxX - minX) * scale));
        const outH = Math.max(1, Math.floor((maxY - minY) * scale));
        const ST = [scale, 0, -scale * minX, 0, scale, -scale * minY, 0, 0, 1];
        const F = G.map(g => mat3mul(ST, g));

        console.log(`Feature Panorama: ${n} frames, anchor=${anchor}, ${weakLinks} weak link(s), ` +
            `feat=${featureCount}/fast=${fastThreshold}/detScale=${detectScale}, ` +
            `${useRigid ? 'RIGID' : 'PLANAR'} (planar ${(bh.area/1e6).toFixed(1)}Mpx stretch ${bh.maxStretch.toFixed(1)}x, ` +
            `rigid ${(br.area/1e6).toFixed(1)}Mpx), ${outW}x${outH}px, scale=${scale.toFixed(3)}`);

        fitPreview(outW, outH);

        // ===== PASS 2: warp + feather-blend each frame into the panorama =====
        const panoCanvas = document.createElement('canvas');
        panoCanvas.width = outW;
        panoCanvas.height = outH;
        const panoCtx = panoCanvas.getContext('2d');
        panoCtx.fillStyle = 'black';
        panoCtx.fillRect(0, 0, outW, outH);

        const tileCanvas = document.createElement('canvas');
        const tileCtx = tileCanvas.getContext('2d');

        let skipped = 0;
        for (let i = 0; i < n; i++) {
            if (isCancelled()) throw new Error("cancelled");
            const frame = frames[i];
            setStatus(t("status.stitchingPercent", {pct: Math.round(100 * (i + 1) / n)}));

            const src = await decodeFeatherSrc(cv, videoData, frame, W, H, frameCtx, featherAlpha);
            if (!src) { skipped++; continue; }
            try {
                if (!warpFrameOnto(cv, src, F[i], panoCtx, tileCanvas, tileCtx, outW, outH, corners)) skipped++;
            } finally {
                src.delete();
            }

            if (i % 4 === 0) {
                showPreview(() => previewCtx.drawImage(panoCanvas, 0, 0, previewCanvas.width, previewCanvas.height));
                setMenuLabel("status.renderingPercent", {pct: Math.round(100 * (i + 1) / n)});
                await new Promise(r => setTimeout(r, 0));
            }
        }
        previewCtx.drawImage(panoCanvas, 0, 0, previewCanvas.width, previewCanvas.height);

        if (mode === "video") {
            await renderFeaturePanoVideo({
                cv, videoData, frames, n, F, outW, outH, W, H, featherAlpha, frameCtx,
                panoCanvas, corners, previewCanvas, previewCtx, setStatus, setMenuLabel, t,
                showPreview, isCancelled,
            });
        } else {
            setStatus(t("status.saving"));
            setMenuLabel("status.saving");
            await new Promise((resolve) => {
                panoCanvas.toBlob((blob) => {
                    if (blob) {
                        const filename = `${getExportPrefix()}_feature_panorama_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = filename;
                        a.click();
                        URL.revokeObjectURL(url);
                        console.log(`Feature panorama exported: ${filename} (${skipped} frame(s) skipped)`);
                    }
                    resolve();
                }, 'image/png');
            });
        }

    } catch (e) {
        if (e.message !== "cancelled") {
            console.error('Feature panorama export failed:', e);
            alert('Feature panorama export failed: ' + e.message);
        } else {
            console.log('Feature panorama export cancelled');
        }
    } finally {
        for (const m of persistent) { try { m.delete(); } catch (_) { /* already freed */ } }
        if (prevDes) { try { prevDes.delete(); } catch (_) { /* already freed */ } }
        if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
        Globals.justVideoAnalysis = savedJustVideoAnalysis;
        par.paused = savedPaused;
        par.frame = savedFrame;
        GlobalDateTimeNode?.update(savedFrame);
        if (doneLabel) setMenuLabel(doneLabel);
        setRenderOne(true);
    }
}

// Render the feature-pano VIDEO: a static feature-stitched background with each
// source frame warped (by the same transform that stitched it) into its place.
async function renderFeaturePanoVideo(c) {
    const {cv, videoData, frames, n, F, outW, outH, W, H, featherAlpha, frameCtx,
           panoCanvas, corners, previewCanvas, previewCtx, setStatus, setMenuLabel, t, showPreview, isCancelled} = c;

    setStatus(t("status.renderingVideo"));

    // Output: fit the panorama within 4K, preserving aspect; even dimensions.
    const s = Math.min(PANO_VIDEO_MAX_W / outW, PANO_VIDEO_MAX_H / outH);
    const vidW = Math.max(2, Math.round(outW * s / 2) * 2);
    const vidH = Math.max(2, Math.round(outH * s / 2) * 2);
    const Svid = [vidW / outW, 0, 0, 0, vidH / outH, 0, 0, 0, 1];

    const {createVideoExporter, getVideoExtension, getBestFormatForResolution, checkVideoEncodingSupport} = await import("./VideoExporter");
    const support = await checkVideoEncodingSupport();
    if (!support || !support.supported) { alert("Video encoding is not supported in this browser"); return; }
    const formatId = support.h264 ? 'mp4-h264' : 'webm-vp8';
    const best = await getBestFormatForResolution(formatId, vidW, vidH);
    if (!best.formatId) { alert("Feature pano video export not available: " + (best.reason || "")); return; }
    const extension = getVideoExtension(best.formatId);

    // Static background = the stitched panorama scaled to the video size.
    const bgCanvas = document.createElement('canvas');
    bgCanvas.width = vidW; bgCanvas.height = vidH;
    const bgCtx = bgCanvas.getContext('2d');
    bgCtx.fillStyle = 'black'; bgCtx.fillRect(0, 0, vidW, vidH);
    bgCtx.drawImage(panoCanvas, 0, 0, vidW, vidH);

    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = vidW; compositeCanvas.height = vidH;
    const compositeCtx = compositeCanvas.getContext('2d');
    const tileCanvas = document.createElement('canvas');
    const tileCtx = tileCanvas.getContext('2d');

    const exporter = await createVideoExporter(best.formatId, {
        width: vidW, height: vidH, fps: Sit.fps,
        bitrate: 20_000_000, keyFrameInterval: 30,
        hardwareAcceleration: best.hardwareAcceleration,
    });
    await exporter.initialize();

    try {
        for (let i = 0; i < n; i++) {
            if (isCancelled()) throw new Error("cancelled");
            setStatus(t("status.videoPercent", {pct: Math.round(100 * (i + 1) / n)}));

            compositeCtx.drawImage(bgCanvas, 0, 0);            // feature-stitched background
            compositeCtx.fillStyle = 'rgba(0, 0, 0, 0.45)';   // dim it so the live frame pops
            compositeCtx.fillRect(0, 0, vidW, vidH);

            const Fv = mat3mul(Svid, F[i]);                    // source -> video coords
            const src = await decodeFeatherSrc(cv, videoData, frames[i], W, H, frameCtx, featherAlpha);
            if (src) {
                try {
                    warpFrameOnto(cv, src, Fv, compositeCtx, tileCanvas, tileCtx, vidW, vidH, corners);
                } finally {
                    src.delete();
                }
            }
            drawQuadOutline(compositeCtx, Fv, corners);        // show where the live frame is

            await exporter.addFrame(compositeCanvas, frames[i]);

            if (i % 3 === 0) {
                showPreview(() => previewCtx.drawImage(compositeCanvas, 0, 0, previewCanvas.width, previewCanvas.height));
                setMenuLabel("status.videoPercent", {pct: Math.round(100 * (i + 1) / n)});
                await new Promise(r => setTimeout(r, 0));
            }
        }

        if (!isCancelled()) {
            setStatus(t("status.saving"));
            const blob = await exporter.finalize(null, (st) => setStatus(st));
            const filename = `${getExportPrefix()}_feature_pano_video_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${extension}`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);
            console.log(`Feature pano video exported: ${filename} (${vidW}x${vidH})`);
        }
    } finally {
        try { exporter.dispose?.(); } catch (_) { /* ignore */ }
    }
}

export const exportFeaturePanorama = (o) => runFeaturePano(o, "image");
export const exportFeaturePanoramaVideo = (o) => runFeaturePano(o, "video");

// Auto-tune the feature-detection parameters for the content AROUND the current
// frame. Grid-searches (detection downscale × FAST contrast threshold), scoring
// each combo by the number of COHERENT multi-frame tracklets it yields over a few
// neighbouring frames (not raw inlier count, which just rewards a flood of noise
// matches), and returns the best {featureCount, fastThreshold, detectScale, score,
// tested}. Cheap: it only touches a handful of frames, not the whole A-B range.
const OPT_SCALES = [1, 2, 4, 8];
const OPT_THRESHOLDS = [20, 10, 5, 2];  // include very-low thresholds for faint, low-contrast content
const OPT_FEATURE_COUNT = 3000;         // generous cap during the sweep so matching isn't starved
const OPT_FRAME_SPAN = 2;               // sample frames at offsets [-2..+2] * frameStep around current

export async function optimizeFeatureTracking(o) {
    const cv = o.cv;
    const videoData = o.videoData;
    const startFrame = o.startFrame;
    const endFrame = o.endFrame;
    const frameStep = Math.max(1, Math.round(o.frameStep || 1));
    const crop = Math.max(0, Math.round(o.crop || 0));
    const useMask = !!o.useMask && !!o.maskImageData;
    const maskImageData = o.maskImageData || null;
    const setMenuLabel = o.setMenuLabel || (() => {});
    const center = Math.max(startFrame, Math.min(endFrame, o.currentFrame ?? startFrame));

    if (!cv || !cv.Mat) { alert("OpenCV not available for feature optimization"); return null; }

    // Build a small, ordered, deduped set of frames around the current frame.
    const frameSet = [];
    for (let d = -OPT_FRAME_SPAN; d <= OPT_FRAME_SPAN; d++) {
        const f = center + d * frameStep;
        if (f >= startFrame && f <= endFrame && !frameSet.includes(f)) frameSet.push(f);
    }
    frameSet.sort((a, b) => a - b);
    if (frameSet.length < 2) {
        alert("Need at least two frames around the current frame to optimize (widen the A-B range)");
        return null;
    }

    const savedPaused = par.paused;
    const savedFrame = par.frame;
    const savedJVA = Globals.justVideoAnalysis;
    Globals.justVideoAnalysis = true;
    par.paused = true;

    const grays = [];
    const persistent = [];
    try {
        const first = await loadVideoFrame(videoData, frameSet[0]);
        if (!first) { alert("Could not load a video frame for optimization"); return null; }
        const W = first.width, H = first.height;

        const frameCanvas = document.createElement('canvas');
        frameCanvas.width = W;
        frameCanvas.height = H;
        const frameCtx = frameCanvas.getContext('2d', {willReadFrequently: true});

        const detectMask = buildDetectMask(cv, W, H, crop, useMask, maskImageData);
        if (detectMask) persistent.push(detectMask);
        const noMask = new cv.Mat();
        persistent.push(noMask);

        // Decode each sample frame once to a full-resolution gray Mat.
        for (const f of frameSet) {
            const img = await loadVideoFrame(videoData, f);
            if (!img) { grays.push(null); continue; }
            frameCtx.clearRect(0, 0, W, H);
            frameCtx.drawImage(img, 0, 0, W, H);
            const id = frameCtx.getImageData(0, 0, W, H);
            const src = cv.matFromImageData(id);
            const gray = new cv.Mat();
            cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
            src.delete();
            grays.push(gray);
        }

        let best = null;
        let tested = 0;
        const totalCombos = OPT_SCALES.length * OPT_THRESHOLDS.length;

        const optMinLen = Math.max(2, Math.min(MIN_TRACKLET_LEN, grays.filter(Boolean).length));
        for (const scale of OPT_SCALES) {
            for (const thr of OPT_THRESHOLDS) {
                const orb = makeORB(cv, OPT_FEATURE_COUNT, thr, Math.min(W, H) / scale);
                const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
                const trk = makeTracker(optMinLen);
                let prevDes = null;
                try {
                    for (let gi = 0; gi < grays.length; gi++) {
                        const g = grays[gi];
                        if (!g) { if (prevDes) { prevDes.delete(); prevDes = null; } continue; }
                        const det = detectFeatures(cv, orb, g, detectMask, noMask, scale);
                        const pairs = prevDes ? matchMutual(cv, bf, prevDes, det.des) : null;
                        trk.addFrame(gi, det.kp, pairs);
                        if (prevDes) prevDes.delete();
                        prevDes = det.des;
                    }
                } finally {
                    if (prevDes) prevDes.delete();
                    orb.delete();
                    bf.delete();
                }

                // Score = count of COHERENT multi-frame tracklets (stable, trackable
                // features) — NOT raw inlier count, which just rewards a flood of noise
                // matches at low threshold / full resolution.
                const score = trk.finish().filter(tr => trackIsCoherent(tr, TRACKLET_COHERENCE_TOL)).length;
                if (!best || score > best.score) best = {detectScale: scale, fastThreshold: thr, score};
                tested++;
                setMenuLabel("status.optimizingPercent", {pct: Math.round(100 * tested / totalCombos)});
                await new Promise(r => setTimeout(r, 0));
            }
        }

        if (best) {
            best.featureCount = OPT_FEATURE_COUNT;
            best.tested = tested;
            console.log(`Optimize Feature Tracking: best detScale=${best.detectScale}, ` +
                `fast=${best.fastThreshold}, feat=${best.featureCount} ` +
                `(${best.score} coherent tracklets over ${frameSet.length} frames)`);
        }
        return best;
    } catch (e) {
        console.error('Feature optimization failed:', e);
        alert('Feature optimization failed: ' + e.message);
        return null;
    } finally {
        for (const g of grays) { if (g) { try { g.delete(); } catch (_) { /* freed */ } } }
        for (const m of persistent) { try { m.delete(); } catch (_) { /* freed */ } }
        Globals.justVideoAnalysis = savedJVA;
        par.paused = savedPaused;
        par.frame = savedFrame;
        GlobalDateTimeNode?.update(savedFrame);
        setRenderOne(true);
    }
}

// ---- matching, multi-frame tracklets & transform fitting ----------------

// Mutual (forward-backward) ratio match between two frames' descriptors. Returns
// index pairs {c, p}: cur keypoint c and prev keypoint p are EACH OTHER's
// ratio-passing nearest neighbour. The mutual requirement rejects the asymmetric
// one-off matches that would otherwise seed false tracks.
function matchMutual(cv, bf, prevDes, curDes) {
    if (!prevDes || !curDes || prevDes.rows < 2 || curDes.rows < 2) return [];
    const fwd = new cv.DMatchVectorVector();   // cur -> prev
    const bwd = new cv.DMatchVectorVector();   // prev -> cur
    const pairs = [];
    try {
        bf.knnMatch(curDes, prevDes, fwd, 2);
        bf.knnMatch(prevDes, curDes, bwd, 2);
        const fwdBest = new Map();
        for (let m = 0; m < fwd.size(); m++) {
            const pr = fwd.get(m); if (pr.size() < 2) continue;
            const a = pr.get(0), b = pr.get(1);
            if (a.distance < RATIO_TEST * b.distance) fwdBest.set(a.queryIdx, a.trainIdx);
        }
        const bwdBest = new Map();
        for (let m = 0; m < bwd.size(); m++) {
            const pr = bwd.get(m); if (pr.size() < 2) continue;
            const a = pr.get(0), b = pr.get(1);
            if (a.distance < RATIO_TEST * b.distance) bwdBest.set(a.queryIdx, a.trainIdx);
        }
        for (const [c, p] of fwdBest) if (bwdBest.get(p) === c) pairs.push({c, p});
    } finally {
        fwd.delete();
        bwd.delete();
    }
    return pairs;
}

// Incremental multi-frame tracker. Feed frames in order with their keypoints and
// the mutual matches to the PREVIOUS frame ({c,p} pairs, or null/[] to break the
// chain). Chains matches into tracks ({pts:[{i,x,y}...], lastI}). A track shorter
// than minLen is dropped the instant it dies, so memory stays bounded over long
// sequences. finish() returns all tracks that reached >= minLen frames.
function makeTracker(minLen) {
    const closed = [];
    let activeByPrevIdx = new Map();   // previous frame's keypoint index -> its track
    let prevKP = null;
    return {
        addFrame(i, kp, pairs) {
            const newActive = new Map();
            const extended = new Set();
            if (pairs) {
                for (const {c, p} of pairs) {
                    let tr = activeByPrevIdx.get(p);
                    if (tr && tr.lastI === i - 1) {
                        tr.pts.push({i, x: kp[c].x, y: kp[c].y});
                        tr.lastI = i;
                    } else {
                        tr = {pts: [{i: i - 1, x: prevKP[p].x, y: prevKP[p].y}, {i, x: kp[c].x, y: kp[c].y}], lastI: i};
                    }
                    newActive.set(c, tr);
                    extended.add(tr);
                }
            }
            for (const tr of activeByPrevIdx.values()) {
                if (!extended.has(tr) && tr.pts.length >= minLen) closed.push(tr);
            }
            activeByPrevIdx = newActive;
            prevKP = kp;
        },
        finish() {
            for (const tr of activeByPrevIdx.values()) if (tr.pts.length >= minLen) closed.push(tr);
            activeByPrevIdx = new Map();
            return closed;
        },
        activePersistent(ml) {
            const out = [], seen = new Set();
            for (const tr of activeByPrevIdx.values()) {
                if (seen.has(tr) || tr.pts.length < ml) continue;
                seen.add(tr);
                const last = tr.pts[tr.pts.length - 1];
                out.push({x: last.x, y: last.y});
            }
            return out;
        },
    };
}

// A tracklet is COHERENT when (almost) every consecutive step is close to the
// track's median step — i.e. near-constant velocity. Sensor-noise "tracks" jitter
// randomly and fail this; real drifting scene features pass. Tracks are contiguous
// by construction, so only step consistency is tested.
function trackIsCoherent(tr, tol) {
    const p = tr.pts;
    if (p.length < 3) return true;
    const vx = [], vy = [];
    for (let j = 1; j < p.length; j++) { vx.push(p[j].x - p[j-1].x); vy.push(p[j].y - p[j-1].y); }
    const mx = vx.slice().sort((a, b) => a - b)[vx.length >> 1];
    const my = vy.slice().sort((a, b) => a - b)[vy.length >> 1];
    let bad = 0;
    for (let j = 0; j < vx.length; j++) if (Math.hypot(vx[j] - mx, vy[j] - my) > tol) bad++;
    return bad <= Math.floor(vx.length * 0.25);   // tolerate up to 25% jittery steps
}

// Gather per-adjacent-pair correspondences (cur[i] / prev[i] flat coord arrays)
// from surviving tracklets: every consecutive (i-1 -> i) hop of every tracklet.
function pairCorrespondences(survivors, n) {
    const cur = new Array(n), prev = new Array(n);
    for (let i = 1; i < n; i++) { cur[i] = []; prev[i] = []; }
    for (const tr of survivors) {
        const p = tr.pts;
        for (let j = 1; j < p.length; j++) {
            const i = p[j].i;
            if (i >= 1 && i < n && p[j - 1].i === i - 1) {
                cur[i].push(p[j].x, p[j].y);
                prev[i].push(p[j - 1].x, p[j - 1].y);
            }
        }
    }
    return {cur, prev};
}

function corrToPoints(pts) {
    const a = [];
    for (let k = 0; k < pts.length / 2; k++) a.push({x: pts[2*k], y: pts[2*k+1]});
    return a;
}

// Fit the transform mapping CURRENT-frame points onto PREVIOUS-frame points from
// explicit (already-clean, tracklet-derived) correspondences. Returns
// {H, rigid, weak, matched}: H is the RANSAC homography (or a median-translation
// fallback), rigid is a rotation+translation fit on the homography inliers.
// weak=true when no reliable homography was found.
function fitFromCorrespondences(cv, curPts, prevPts) {
    const good = curPts.length / 2;
    const fallback = () => {
        if (good >= 1) {
            const dxs = [], dys = [];
            for (let k = 0; k < good; k++) { dxs.push(prevPts[2*k] - curPts[2*k]); dys.push(prevPts[2*k+1] - curPts[2*k+1]); }
            dxs.sort((a, b) => a - b); dys.sort((a, b) => a - b);
            const m = good >> 1;
            const tr = translate3(dxs[m], dys[m]);
            return {H: tr, rigid: tr, weak: true, matched: corrToPoints(curPts)};
        }
        return {H: IDENTITY3.slice(), rigid: IDENTITY3.slice(), weak: true, matched: []};
    };
    if (good < MIN_GOOD_MATCHES) return fallback();

    const srcM = cv.matFromArray(good, 1, cv.CV_32FC2, curPts);
    const dstM = cv.matFromArray(good, 1, cv.CV_32FC2, prevPts);
    const inlierMask = new cv.Mat();
    let Hm = null, result = null;
    try {
        Hm = cv.findHomography(srcM, dstM, cv.RANSAC, RANSAC_REPROJ, inlierMask);
        if (Hm && Hm.rows === 3 && Hm.cols === 3) {
            let inliers = 0;
            const maskArr = new Uint8Array(inlierMask.rows);
            for (let k = 0; k < inlierMask.rows; k++) { maskArr[k] = inlierMask.data[k]; if (maskArr[k]) inliers++; }
            const arr = [];
            for (let k = 0; k < 9; k++) arr.push(Hm.data64F[k]);
            if (inliers >= MIN_INLIERS && inliers / good >= MIN_INLIER_RATIO && isReasonableHomography(arr)) {
                const rigid = rigidFromMatches(curPts, prevPts, maskArr) || arr;
                const inMatched = [];
                for (let k = 0; k < good; k++) if (maskArr[k]) inMatched.push({x: curPts[2*k], y: curPts[2*k+1]});
                result = {H: arr, rigid, weak: false, matched: inMatched};
            }
        }
    } catch (_) { /* fall through */ }
    if (Hm) { try { Hm.delete(); } catch (_) { /* already freed */ } }
    srcM.delete();
    dstM.delete();
    inlierMask.delete();

    return result || fallback();
}

function isReasonableHomography(H) {
    for (let k = 0; k < 9; k++) if (!isFinite(H[k])) return false;
    const sx = Math.hypot(H[0], H[3]);
    const sy = Math.hypot(H[1], H[4]);
    if (sx < 0.5 || sx > 2.0 || sy < 0.5 || sy > 2.0) return false;
    if (Math.abs(H[6]) > 0.01 || Math.abs(H[7]) > 0.01) return false;
    return true;
}
