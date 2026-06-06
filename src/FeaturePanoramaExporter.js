/**
 * Feature-based panorama exporter — "Export Feature Pano".
 *
 * A separate, more capable panorama path than "Export Motion Panorama"
 * (CMotionAnalysisUI.js / exportMotionPanorama). The Motion Panorama uses the
 * optical-flow camera-motion estimate to paste each video frame with only a 2D
 * TRANSLATION (+ optional whole-image rotation), so any per-frame rotation or
 * perspective shows up as mis-registration. This path registers frames with
 * industry-standard feature matching and warps them to fit.
 *
 * Pipeline (entirely on the actual video frames):
 *   1. ORB feature detection + 256-bit BRIEF descriptors per frame.
 *   2. Brute-force Hamming knn matching between consecutive frames + Lowe
 *      ratio test (0.75) for confident matches.
 *   3. cv.findHomography(RANSAC) per adjacent pair, and from its inliers a
 *      robust RIGID (rotation + translation) transform as well.
 *   4. Compose the per-pair transforms into a common frame, anchored at the
 *      MIDDLE frame (halves worst-case drift).
 *   5. Pick the model: a full-homography mosaic captures perspective (great for
 *      translating/aerial captures), but a planar homography mosaic EXPLODES as
 *      camera rotation grows past ~45° (frames approach the projective
 *      singularity → the whole panorama collapses to a black speck). When that
 *      blow-up is detected we fall back to the RIGID chain, which has no
 *      perspective DOF, cannot diverge, and gives the correct flat / cylindrical
 *      unrolling for a (narrow-FOV) rotating camera — no focal length needed.
 *   6. cv.warpPerspective each frame onto the panorama + feather-blend.
 *
 * Burned-in HUD / reticle / redaction graphics are STATIC in image space: if
 * ORB matched on them the transform would be dragged toward identity, so the
 * redaction mask (and the crop ring) is used as an ORB *detection* mask.
 *
 * OpenCV.js Mat lifecycle is the biggest risk (a missed .delete() in the
 * per-frame loop OOMs the WASM heap), so every Mat is freed per-iteration via
 * try/finally and the long-lived objects in the outer finally on every path.
 */

import {GlobalDateTimeNode, Globals, setRenderOne} from "./Globals";
import {par} from "./par";
import {getExportPrefix} from "./utils";

// Browser 2D-canvas limits — see the matching notes in PanoramaExporter.js and
// CMotionAnalysisUI.js. An over-limit canvas fails SILENTLY (drawImage paints
// nothing, reads back black), so clamp BOTH the largest dimension and the area.
const MAX_PANORAMA_DIM = 16384;
const MAX_PANORAMA_AREA = 128 * 1024 * 1024; // ~134M px, safely under the limit

// Registration tuning.
const DEFAULT_FEATURE_COUNT = 2000;     // ORB keypoints per frame
const RATIO_TEST = 0.75;                // Lowe ratio for knn match filtering
const RANSAC_REPROJ = 3.0;              // px reprojection threshold for findHomography
const MIN_GOOD_MATCHES = 12;            // below this, fall back to translation
const MIN_INLIERS = 10;                 // RANSAC inliers required to trust a homography
const MIN_INLIER_RATIO = 0.25;          // inliers / good matches required
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

// Best-fit RIGID transform (rotation + translation, scale fixed at 1) mapping the
// `cur` points onto the `prev` points (Umeyama, scale=1). Optionally restricted
// to the inlier set. Returns a 3x3 (homography form) or null. A rigid transform
// has no perspective DOF, so chaining it can never blow up — the key robustness
// property for rotating-camera panoramas.
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

// Decode a frame into an RGBA cv.Mat with the feather/mask baked into its alpha
// channel. Caller owns the returned Mat. Returns null if the frame won't load.
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

// Composite a warped RGBA tile (CV_8UC4) onto the panorama with source-over.
function compositeTile(panoCtx, tileCanvas, tileCtx, dst, rx, ry, rw, rh) {
    const tileImg = new ImageData(new Uint8ClampedArray(dst.data), rw, rh);
    tileCanvas.width = rw;
    tileCanvas.height = rh;
    tileCtx.putImageData(tileImg, 0, 0);
    panoCtx.drawImage(tileCanvas, rx, ry);
}

// Compose per-pair transforms M[i] (mapping frame i -> i-1) into global
// transforms G[i] (mapping frame i -> anchor), anchored at the middle frame.
function composeChain(M, n, anchor) {
    const G = new Array(n).fill(null);
    G[anchor] = IDENTITY3.slice();
    for (let i = anchor + 1; i < n; i++) {
        G[i] = mat3mul(G[i - 1], M[i] || IDENTITY3.slice());           // i -> anchor
    }
    for (let i = anchor - 1; i >= 0; i--) {
        const inv = mat3inv(M[i + 1] || IDENTITY3.slice());            // i -> i+1
        G[i] = mat3mul(G[i + 1], inv || IDENTITY3.slice());
    }
    return G;
}

// Bounding box of all frames' projected corners, plus the worst per-frame
// projected-area stretch (× source area) and a non-finite flag. Used both to
// size the canvas and to detect planar-mosaic blow-up.
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

// ---- core export ---------------------------------------------------------

/**
 * @param {object} o
 * @param {object} o.cv               loaded OpenCV.js namespace
 * @param {object} o.videoData        the video view's videoData
 * @param {number} o.startFrame       first frame (inclusive)
 * @param {number} o.endFrame         last frame (inclusive)
 * @param {number} [o.frameStep=1]    frames to step between stitched frames
 * @param {number} [o.crop=0]         px ring ignored at each frame edge
 * @param {boolean} [o.useMask=false] use the redaction mask to exclude static graphics
 * @param {ImageData} [o.maskImageData] redaction mask (alpha>128 = masked)
 * @param {number} [o.featureCount]   ORB keypoints per frame
 * @param {string} [o.projection]     "auto" (default) | "planar" | "rigid"
 * @param {function} [o.t]            translator (key, opts) -> string
 * @param {function} [o.setMenuLabel] (key, opts) -> void
 * @param {string}  [o.doneLabel]     menu label key to restore when finished
 */
export async function exportFeaturePanorama(o) {
    const cv = o.cv;
    const videoData = o.videoData;
    const startFrame = o.startFrame;
    const endFrame = o.endFrame;
    const frameStep = Math.max(1, Math.round(o.frameStep || 1));
    const crop = Math.max(0, Math.round(o.crop || 0));
    const useMask = !!o.useMask && !!o.maskImageData;
    const maskImageData = o.maskImageData || null;
    const featureCount = o.featureCount || DEFAULT_FEATURE_COUNT;
    const projection = o.projection || "auto";
    const t = o.t || ((k) => k);
    const setMenuLabel = o.setMenuLabel || (() => {});
    const doneLabel = o.doneLabel || null;

    if (!cv || !cv.Mat) { alert("OpenCV not available for feature panorama"); return; }
    if (endFrame <= startFrame) { alert("Select a frame range (A-B) before exporting a feature panorama"); return; }

    const frames = [];
    for (let f = startFrame; f <= endFrame; f += frameStep) frames.push(f);
    const n = frames.length;
    if (n < 2) { alert("Need at least two frames for a panorama"); return; }

    // Capture + set playback state up front (before any decode mutates par.frame)
    // so the finally restores the user's actual playhead.
    const savedPaused = par.paused;
    const savedFrame = par.frame;
    const savedJustVideoAnalysis = Globals.justVideoAnalysis;
    Globals.justVideoAnalysis = true;
    par.paused = true;

    let overlay = null;
    const persistent = [];   // long-lived cv objects, freed in finally
    let prevKP = null;
    let prevDes = null;      // carried PASS-1 descriptors (cv.Mat) — freed in finally
    let panoCanvas = null;
    let weakLinks = 0;
    let cancelled = false;

    try {
        const firstImage = await loadVideoFrame(videoData, frames[0]);
        if (!firstImage) { alert("Could not load the first video frame"); return; }
        const W = firstImage.width;
        const H = firstImage.height;
        const corners = [[0, 0], [W, 0], [W, H], [0, H]];

        // ---- full-screen progress overlay (also hides live-viewport churn) ----
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

        const frameCanvas = document.createElement('canvas');
        frameCanvas.width = W;
        frameCanvas.height = H;
        const frameCtx = frameCanvas.getContext('2d', {willReadFrequently: true});

        // ORB detection mask: 0 over the crop ring and burned-in redaction graphics.
        let detectMask = null;
        if (useMask || crop > 0) {
            detectMask = cv.Mat.ones(H, W, cv.CV_8UC1);
            persistent.push(detectMask);
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
        }
        const noMask = new cv.Mat();
        persistent.push(noMask);

        // Per-frame feather/mask alpha (0..255) baked into the warp source's alpha.
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

        const orb = new cv.ORB(featureCount);
        persistent.push(orb);
        const bf = new cv.BFMatcher(cv.NORM_HAMMING, false);
        persistent.push(bf);

        // ===== PASS 1: detect features + estimate pairwise transforms =====
        // Mh[i]/Mr[i] map frame i -> frame (i-1) (homography / rigid).
        const Mh = new Array(n).fill(null);
        const Mr = new Array(n).fill(null);

        for (let i = 0; i < n; i++) {
            if (cancelled) throw new Error("cancelled");
            const frame = frames[i];
            setStatus(t("status.loadingFrame", {frame, current: i + 1, total: n}));

            const image = await loadVideoFrame(videoData, frame);
            if (!image) { if (i > 0) { Mh[i] = IDENTITY3.slice(); Mr[i] = IDENTITY3.slice(); } continue; }
            frameCtx.clearRect(0, 0, W, H);
            frameCtx.drawImage(image, 0, 0, W, H);
            const id = frameCtx.getImageData(0, 0, W, H);

            let src = null, gray = null, kpVec = null, des = null;
            try {
                src = cv.matFromImageData(id);
                gray = new cv.Mat();
                cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
                src.delete(); src = null;

                kpVec = new cv.KeyPointVector();
                des = new cv.Mat();
                orb.detectAndCompute(gray, detectMask || noMask, kpVec, des);
                gray.delete(); gray = null;

                const kp = new Array(kpVec.size());
                for (let k = 0; k < kpVec.size(); k++) {
                    const p = kpVec.get(k).pt;
                    kp[k] = {x: p.x, y: p.y};
                }
                kpVec.delete(); kpVec = null;

                if (i > 0) {
                    const res = estimatePairwise(cv, bf, prevKP, prevDes, kp, des);
                    if (res.weak) weakLinks++;
                    Mh[i] = res.H;
                    Mr[i] = res.rigid;
                }

                if (prevDes) prevDes.delete();
                prevKP = kp;
                prevDes = des;
                des = null; // handed off
            } finally {
                if (src) src.delete();
                if (gray) gray.delete();
                if (kpVec) kpVec.delete();
                if (des) des.delete();
            }

            if (i % 4 === 0) {
                setMenuLabel("status.analyzingPercent", {pct: Math.round(100 * (i + 1) / n)});
                setStatus(t("status.detectingFeaturesPercent", {pct: Math.round(100 * (i + 1) / n)}));
                await new Promise(r => setTimeout(r, 0));
            }
        }
        if (prevDes) { prevDes.delete(); prevDes = null; }

        // ===== choose the model & compose the global transform chain =====
        // The full-homography mosaic captures perspective but EXPLODES when the
        // chain drifts (noise over many near-identity homographies) or the
        // rotation is large. The rigid (rotation+translation) chain can't drift
        // or stretch, so it is our sanity reference: if the planar bbox is far
        // bigger than the rigid bbox, or any frame stretches wildly, planar has
        // blown up and we use rigid instead (the correct flat/cylindrical
        // unrolling for a rotating camera; no focal length needed).
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
            `${useRigid ? 'RIGID' : 'PLANAR'} (planar ${(bh.area/1e6).toFixed(1)}Mpx stretch ${bh.maxStretch.toFixed(1)}x, ` +
            `rigid ${(br.area/1e6).toFixed(1)}Mpx), ${outW}x${outH}px, scale=${scale.toFixed(3)}`);

        previewCanvas.width = Math.min(1600, outW);
        previewCanvas.height = Math.max(1, Math.round(previewCanvas.width * outH / outW));

        // ===== PASS 2: warp + feather-blend each frame onto the panorama =====
        panoCanvas = document.createElement('canvas');
        panoCanvas.width = outW;
        panoCanvas.height = outH;
        const panoCtx = panoCanvas.getContext('2d');
        panoCtx.fillStyle = 'black';
        panoCtx.fillRect(0, 0, outW, outH);

        const tileCanvas = document.createElement('canvas');
        const tileCtx = tileCanvas.getContext('2d');

        let skipped = 0;
        for (let i = 0; i < n; i++) {
            if (cancelled) throw new Error("cancelled");
            const frame = frames[i];
            setStatus(t("status.stitchingPercent", {pct: Math.round(100 * (i + 1) / n)}));

            let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
            let badCorner = false;
            for (const [ccx, ccy] of corners) {
                const [px, py] = applyH(F[i], ccx, ccy);
                if (!isFinite(px) || !isFinite(py)) { badCorner = true; break; }
                if (px < bx0) bx0 = px; if (px > bx1) bx1 = px;
                if (py < by0) by0 = py; if (py > by1) by1 = py;
            }
            if (badCorner) { skipped++; continue; }
            const rx = Math.max(0, Math.floor(bx0));
            const ry = Math.max(0, Math.floor(by0));
            const rw = Math.min(outW, Math.ceil(bx1)) - rx;
            const rh = Math.min(outH, Math.ceil(by1)) - ry;
            if (rw <= 0 || rh <= 0) { skipped++; continue; }

            const src = await decodeFeatherSrc(cv, videoData, frame, W, H, frameCtx, featherAlpha);
            if (!src) { skipped++; continue; }

            let dst = null, Hm = null;
            try {
                dst = new cv.Mat();
                const Htile = mat3mul(translate3(-rx, -ry), F[i]);
                Hm = cv.matFromArray(3, 3, cv.CV_64F, Htile);
                cv.warpPerspective(src, dst, Hm, new cv.Size(rw, rh),
                    cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));
                compositeTile(panoCtx, tileCanvas, tileCtx, dst, rx, ry, rw, rh);
            } finally {
                src.delete();
                if (dst) dst.delete();
                if (Hm) Hm.delete();
            }

            if (i % 4 === 0) {
                previewCtx.drawImage(panoCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
                setMenuLabel("status.renderingPercent", {pct: Math.round(100 * (i + 1) / n)});
                await new Promise(r => setTimeout(r, 0));
            }
        }

        previewCtx.drawImage(panoCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
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

// Estimate the transforms mapping the CURRENT frame's pixels onto the PREVIOUS
// frame's pixels. Returns {H, rigid, weak}: H is the full homography (or a
// translation fallback), rigid is a rotation+translation fit on the homography
// inliers (or the same translation fallback). weak=true when no reliable
// homography was found.
function estimatePairwise(cv, bf, prevKP, prevDes, curKP, curDes) {
    const fallback = (dxs, dys) => {
        if (dxs && dxs.length >= 1) {
            const sx = dxs.slice().sort((a, b) => a - b);
            const sy = dys.slice().sort((a, b) => a - b);
            const m = sx.length >> 1;
            const tr = translate3(sx[m], sy[m]);
            return {H: tr, rigid: tr, weak: true};
        }
        return {H: IDENTITY3.slice(), rigid: IDENTITY3.slice(), weak: true};
    };

    if (!prevDes || !curDes || prevDes.rows < 2 || curDes.rows < 2) return fallback();

    const knn = new cv.DMatchVectorVector();
    const curPts = [], prevPts = [], dxs = [], dys = [];
    try {
        bf.knnMatch(curDes, prevDes, knn, 2);   // query=current, train=previous
        for (let m = 0; m < knn.size(); m++) {
            const pair = knn.get(m);
            if (pair.size() < 2) continue;
            const a = pair.get(0), b = pair.get(1);
            if (a.distance < RATIO_TEST * b.distance) {
                const cp = curKP[a.queryIdx];
                const pp = prevKP[a.trainIdx];
                if (!cp || !pp) continue;
                curPts.push(cp.x, cp.y);
                prevPts.push(pp.x, pp.y);
                dxs.push(pp.x - cp.x);
                dys.push(pp.y - cp.y);
            }
        }
    } finally {
        knn.delete();
    }

    const good = curPts.length / 2;
    if (good < MIN_GOOD_MATCHES) return fallback(dxs, dys);

    const srcM = cv.matFromArray(good, 1, cv.CV_32FC2, curPts);
    const dstM = cv.matFromArray(good, 1, cv.CV_32FC2, prevPts);
    const inlierMask = new cv.Mat();
    let Hm = null;
    let result = null;
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
                result = {H: arr, rigid, weak: false};
            }
        }
    } catch (_) { /* fall through */ }
    if (Hm) { try { Hm.delete(); } catch (_) { /* already freed */ } }
    srcM.delete();
    dstM.delete();
    inlierMask.delete();

    return result || fallback(dxs, dys);
}

// Reject wildly distorting / degenerate homographies (a bad RANSAC fit on
// repetitive texture).
function isReasonableHomography(H) {
    for (let k = 0; k < 9; k++) if (!isFinite(H[k])) return false;
    const sx = Math.hypot(H[0], H[3]);
    const sy = Math.hypot(H[1], H[4]);
    if (sx < 0.5 || sx > 2.0 || sy < 0.5 || sy > 2.0) return false;
    if (Math.abs(H[6]) > 0.01 || Math.abs(H[7]) > 0.01) return false;
    return true;
}
