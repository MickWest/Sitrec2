/**
 * Motion Analysis menu, GUI sliders, and panorama/stabilization export code.
 *
 * Split out of CMotionAnalysis.js so that file can stay focused on the
 * MotionAnalyzer class + the per-frame image grayscale path used by its
 * optical-flow methods. This module owns the singleton motionAnalyzer
 * instance, all menu state, panorama geometry helpers, and the
 * stabilization + rendered-panorama export flows.
 *
 * Shared `cv` and `analyzeWithEffects` state are accessed through setter/
 * getter functions exported from CMotionAnalysis.js to avoid an import
 * cycle.
 */

import {
    completePendingWork,
    GlobalDateTimeNode,
    Globals,
    guiMenus,
    NodeMan,
    registerPendingWork,
    setRenderOne,
    Sit
} from "./Globals";
import {isAdmin} from "./configUtils";
import {par} from "./par";
import {ExportProgressWidget, getExportPrefix} from "./utils";
import {Color} from "three";
import {getCV, loadOpenCV} from "./openCVLoader";
import {fitSimilarity} from "./CameraMotionFromVideo";
import {isAlignWithFlowEnabled, setAlignWithFlow, setMotionAnalyzerRef} from "./FlowAlignment";
import {setStartAnalysis, setUpdateGuiValues, setUpdateOptimizeStatus, updateGuiValues} from "./CMotionAnalysisShared";
import {CNodeVelocityFromMotion} from "./nodes/CNodeVelocityFromMotion";
import {CNodeTrackFromVelocity} from "./nodes/CNodeTrackFromVelocity";
import {CNodeDisplayTrack} from "./nodes/CNodeDisplayTrack";
import {
    applyVideoEffectsToCanvas,
    ensureOpenCVAndAnalyzer,
    getAnalyzeWithEffects,
    getVideoEffectsFilterString,
    MOTION_TECHNIQUES,
    MotionAnalyzer,
    mt,
    setAnalyzeWithEffects,
    setCv,
    setMenuItemLabel,
} from "./CMotionAnalysis";

// Panorama constants (shared with the class's export flow below).
// Browser 2D-canvas size limits. A panorama from a large 2D camera sweep can grow
// past what the browser will allocate, and the failure is SILENT: createElement and
// `canvas.width = N` both succeed, every drawImage "succeeds", but the backing store
// is never allocated, so the canvas reads back fully transparent/black. There are two
// independent limits to respect:
//   - MAX_PANORAMA_DIM: the largest single dimension (width OR height). Strict GPUs/
//     drivers cap this around 16384px.
//   - MAX_PANORAMA_AREA: the largest total pixel count. Empirically ~256-320M px here,
//     but it varies by GPU/driver, so we keep a conservative margin.
// Capping only the WIDTH (the original behaviour) was insufficient: a tall sweep kept
// width <= the cap yet blew the AREA limit, producing an all-black "panorama".
const MAX_PANORAMA_DIM = 16384;
const MAX_PANORAMA_AREA = 128 * 1024 * 1024; // ~134M px, safely under the area limit
const PANO_VIDEO_4K_WIDTH = 3840;
const PANO_VIDEO_4K_HEIGHT = 2160;

// Uniform downscale factor that brings a width x height panorama within BOTH the
// per-dimension and total-area canvas limits (1 = no scaling needed). Aspect ratio is
// preserved because the same factor is applied to width and height.
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

// Panorama export toggles — the addMotionAnalysisMenu folder below wires them.
let exportWithEffects = false;
let removeOuterBlack = false;
let panoCrop = 0;
let useMaskInPano = true;
let panoFrameStep = 1;
// When true, the motion pano stamps each frame with a full per-frame similarity
// transform (rotation + translation, off-center safe) recovered from the flow,
// instead of translation only — see calculateFrameTransforms / drawFrameToPano.
let panoRotateFrames = false;
// "Rotate Frames" stamps each frame with its recovered per-frame similarity. A
// full similarity includes a SCALE term, which — being noisy and chained frame to
// frame — accumulates into visible scale drift (frames grow/shrink along the
// panorama). Default OFF: the per-frame transform is constrained to RIGID
// (rotation + translation, scale = 1) so every frame stays the same size. Turn ON
// to restore the old full-similarity behaviour (e.g. a genuinely zooming camera).
let panoAllowFrameScale = false;
// Feature-pano options (separate from the motion-pano ones above).
let panoFeatureFrameStep = 1;
let panoFeatureCrop = 0;
let panoFeatureUseMask = true;
let panoFeatureProjection = "auto"; // "auto" | "planar" | "rigid"

// ---- rotation-aware stamping (similarity transforms) ---------------------
// 3x3 affine helpers (row-major [a,b,c, d,e,f, 0,0,1]); transforms map image
// pixels -> reference-frame pixels.
const PANO_IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
function pmul3(A, B) {
    const C = new Array(9);
    for (let r = 0; r < 3; r++)
        for (let c = 0; c < 3; c++)
            C[r*3+c] = A[r*3]*B[c] + A[r*3+1]*B[3+c] + A[r*3+2]*B[6+c];
    return C;
}
function pinv3(M) {
    const [a, b, c, d, e, f, g, h, i] = M;
    const A = e*i - f*h, B = c*h - b*i, C = b*f - c*e;
    const D = f*g - d*i, E = a*i - c*g, F = c*d - a*f;
    const G = d*h - e*g, H = b*g - a*h, I = a*e - b*d;
    const det = a*A + b*D + c*G;
    if (!isFinite(det) || Math.abs(det) < 1e-18) return null;
    const s = 1/det;
    return [A*s, B*s, C*s, D*s, E*s, F*s, G*s, H*s, I*s];
}
function ppt(M, x, y) { return [M[0]*x + M[1]*y + M[2], M[3]*x + M[4]*y + M[5]]; }
function ptranslate(dx, dy) { return [1, 0, dx, 0, 1, dy, 0, 0, 1]; }

// Per-frame background similarity (prev->cur) recovered by refitting the motion
// analyzer's cached inlier flow vectors with the shared fitSimilarity. Returns a
// 3x3, or null when there are too few vectors to trust a rotation.
function frameSimilarity(motionAnalyzer, frame, W, H) {
    const vectors = motionAnalyzer.resultCache.get(frame)?.flowData?.vectors;
    if (!vectors || vectors.length < 8) return null;
    const P = [], Q = [];
    for (const v of vectors) {
        if (!v.isInlier) continue;
        P.push([v.px, v.py]);
        Q.push([v.px + v.dx, v.py + v.dy]);
    }
    if (P.length < 8) return null;
    const fit = fitSimilarity(P, Q, W, H, {ransacThr: 2.0});
    if (!fit || !isFinite(fit.Ax) || !isFinite(fit.By)) return null;
    if (panoAllowFrameScale) {
        // Full similarity (rotation + translation + SCALE): q = (Ax,-Ay;Ay,Ax)·p + (Bx,By).
        return [fit.Ax, -fit.Ay, fit.Bx, fit.Ay, fit.Ax, fit.By, 0, 0, 1];
    }
    // RIGID (scale = 1): keep the recovered rotation and image-CENTRE translation but
    // drop the scale term, so chained frames can't accumulate scale drift (which made
    // frames grow/shrink along the panorama). Rotate about the image centre by theta,
    // then translate the centre by the fit's (dx,dy):  q = R(theta)·(p - c) + c + d.
    const cos = Math.cos(fit.theta), sin = Math.sin(fit.theta);
    const cx = W / 2, cy = H / 2;
    const bx = cx + fit.dx - (cos * cx - sin * cy);
    const by = cy + fit.dy - (sin * cx + cos * cy);
    return [cos, -sin, bx, sin, cos, by, 0, 0, 1];
}

// Cumulative per-frame transforms G[i] mapping each stamped frame's pixels into
// the reference (first) frame, by chaining the inverse of each per-frame
// background similarity (falling back to the translation-only motion when a
// reliable similarity isn't available). Also returns the projected-corner bbox.
function calculateFrameTransforms(motionAnalyzer, motionData, startFrame, endFrame, frameStep, W, H) {
    const totalFrames = Math.ceil((endFrame - startFrame + 1) / frameStep);
    const corners = [[0, 0], [W, 0], [W, H], [0, H]];
    const frameData = [];
    let G = PANO_IDENTITY3.slice();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const accumCorners = (Gf) => {
        for (const [cx, cy] of corners) {
            const [x, y] = ppt(Gf, cx, cy);
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
    };
    const stepSim = (frame) => {
        const md = motionData[frame];
        return frameSimilarity(motionAnalyzer, frame, W, H)
            || ptranslate(md ? md.dx : 0, md ? md.dy : 0);
    };

    for (let i = 0; i < totalFrames; i++) {
        const frame = startFrame + i * frameStep;
        if (i > 0) {
            // Compose the per-frame similarities spanning this step: S_frame·…·S_lo.
            let Sstep = PANO_IDENTITY3.slice();
            const lo = frameStep === 1 ? frame : frame - frameStep + 1;
            for (let f = lo; f <= frame; f++) Sstep = pmul3(stepSim(f), Sstep);
            G = pmul3(G, pinv3(Sstep) || PANO_IDENTITY3.slice());
        }
        frameData.push({frame, G});
        accumCorners(G);
    }
    return {frameData, totalFrames, minX, minY, maxX, maxY};
}

// Shared layout for both motion-pano exports (image + video). Returns per-frame
// placement as either a translation (x,y) or, when "Rotate Frames" is on, a full
// affine (rotation+translation), plus the panorama dimensions. DRY: both export
// paths consume the same {frameData, panoWidthPx, ...}.
function computePanoLayout(videoData, motionData, startFrame, endFrame, frameStep, crop, panoRotation) {
    const firstImage = videoData.getImage(startFrame);
    const frameWidth = firstImage.width || firstImage.videoWidth || 1920;
    const frameHeight = firstImage.height || firstImage.videoHeight || 1080;

    if (panoRotateFrames) {
        const tf = calculateFrameTransforms(motionAnalyzer, motionData, startFrame, endFrame, frameStep, frameWidth, frameHeight);
        const w0 = Math.max(1, Math.ceil(tf.maxX - tf.minX));
        const h0 = Math.max(1, Math.ceil(tf.maxY - tf.minY));
        const scale = panoFitScale(w0, h0);
        const panoWidthPx = Math.max(1, Math.floor(w0 * scale));
        const panoHeightPx = Math.max(1, Math.floor(h0 * scale));
        const SO = [scale, 0, -scale * tf.minX, 0, scale, -scale * tf.minY, 0, 0, 1];
        const frameData = tf.frameData.map(fd => ({frame: fd.frame, x: 0, y: 0, affine: pmul3(SO, fd.G)}));
        console.log(`Motion Panorama (rotate): ${panoWidthPx}x${panoHeightPx}px, scale=${scale.toFixed(3)}`);
        return {
            rotateMode: true, frameData, totalFrames: tf.totalFrames,
            frameWidth, frameHeight, croppedWidth: frameWidth, croppedHeight: frameHeight,
            panoWidthPx, panoHeightPx, scale, scaledFrameWidth: frameWidth, scaledFrameHeight: frameHeight,
        };
    }

    const off = calculateFrameOffsets(motionData, startFrame, endFrame, frameStep, panoRotation);
    const dims = calculatePanoDimensions(videoData, startFrame, off.minPx, off.maxPx, off.minPy, off.maxPy, crop);
    const frameData = off.frameData.map(fd => ({
        frame: fd.frame, affine: null,
        x: (fd.px - off.minPx) * dims.scale,
        y: (fd.py - off.minPy) * dims.scale,
    }));
    console.log(`Motion Panorama: ${dims.panoWidthPx}x${dims.panoHeightPx}px, scale=${dims.scale.toFixed(3)}`);
    return {rotateMode: false, frameData, totalFrames: off.totalFrames, ...dims};
}

function calculateFrameOffsets(motionData, startFrame, endFrame, frameStep = 1, rotationAngle = 0) {
    const totalFrames = Math.ceil((endFrame - startFrame + 1) / frameStep);
    const frameData = [];
    let cumX = 0, cumY = 0;
    
    const cos = Math.cos(rotationAngle);
    const sin = Math.sin(rotationAngle);
    
    const alignFlow = rotationAngle !== 0;

    const accumulateMotion = (md) => {
        const dx = -md.dx;
        const dy = -md.dy;
        cumX += dx * cos - dy * sin;
        if (!alignFlow) {
            cumY += dx * sin + dy * cos;
        }
    };
    
    for (let i = 0; i < totalFrames; i++) {
        const frame = startFrame + i * frameStep;
        if (i > 0) {
            if (frameStep === 1) {
                accumulateMotion(motionData[frame]);
            } else {
                for (let f = frame - frameStep + 1; f <= frame; f++) {
                    accumulateMotion(motionData[f]);
                }
            }
        }
        frameData.push({frame, px: cumX, py: cumY});
    }

    let minPx = Infinity, maxPx = -Infinity;
    let minPy = Infinity, maxPy = -Infinity;
    for (const fd of frameData) {
        minPx = Math.min(minPx, fd.px);
        maxPx = Math.max(maxPx, fd.px);
        minPy = Math.min(minPy, fd.py);
        maxPy = Math.max(maxPy, fd.py);
    }

    return {frameData, totalFrames, minPx, maxPx, minPy, maxPy};
}

function calculateOverallMotionAngle(motionData, startFrame, endFrame) {
    let totalDx = 0, totalDy = 0;
    for (let f = startFrame; f <= endFrame; f++) {
        const md = motionData[f];
        if (md && md.isGood) {
            totalDx += md.dx;
            totalDy += md.dy;
        }
    }
    if (Math.abs(totalDx) < 0.001 && Math.abs(totalDy) < 0.001) return 0;
    return Math.atan2(totalDy, totalDx);
}

function calculatePanoDimensions(videoData, startFrame, minPx, maxPx, minPy, maxPy, crop) {
    const firstImage = videoData.getImage(startFrame);
    const frameWidth = firstImage.width || firstImage.videoWidth || 1920;
    const frameHeight = firstImage.height || firstImage.videoHeight || 1080;
    // "Panorama Crop" is applied as MASKING, not by cutting the geometry: the outer
    // `crop`-px ring of each frame is masked out (ignored) and filled by neighbouring
    // frames — see drawFrameToPano. So the full frame is always stitched and the
    // panorama dimensions do not change with crop. (Cutting the geometry created a
    // hard source-rect edge that bilinear-sampled the dark cropped-away border,
    // producing the dark "edge-dropping" seams that worsened with crop.)
    const croppedWidth = frameWidth;
    const croppedHeight = frameHeight;

    const pxRange = maxPx - minPx;
    const pyRange = maxPy - minPy;

    let panoWidthPx = Math.ceil(pxRange + croppedWidth);
    let panoHeightPx = Math.ceil(pyRange + croppedHeight);

    // Clamp to the browser canvas limits (both dimension and total area). Without this
    // a large sweep produces an over-limit canvas that silently stays black.
    const scale = panoFitScale(panoWidthPx, panoHeightPx);
    if (scale < 1) {
        panoWidthPx = Math.max(1, Math.floor(panoWidthPx * scale));
        panoHeightPx = Math.max(1, Math.floor(panoHeightPx * scale));
    }

    return {
        frameWidth, frameHeight,
        croppedWidth, croppedHeight,
        panoWidthPx, panoHeightPx,
        scale,
        scaledFrameWidth: Math.ceil(croppedWidth * scale),
        scaledFrameHeight: Math.ceil(croppedHeight * scale),
    };
}

function processRemoveOuterBlack(imageData) {
    const pixels = imageData.data;
    const width = imageData.width;
    const height = imageData.height;
    const BLACK_THRESHOLD = 5;
    
    for (let row = 0; row < height; row++) {
        const rowStart = row * width * 4;
        
        const firstIdx = rowStart;
        const firstR = pixels[firstIdx];
        const firstG = pixels[firstIdx + 1];
        const firstB = pixels[firstIdx + 2];
        if (firstR < BLACK_THRESHOLD && firstG < BLACK_THRESHOLD && firstB < BLACK_THRESHOLD) {
            for (let col = 0; col < width; col++) {
                const idx = rowStart + col * 4;
                const r = pixels[idx];
                const g = pixels[idx + 1];
                const b = pixels[idx + 2];
                if (r < BLACK_THRESHOLD && g < BLACK_THRESHOLD && b < BLACK_THRESHOLD) {
                    pixels[idx + 3] = 0;
                } else {
                    break;
                }
            }
        }
        
        const lastIdx = rowStart + (width - 1) * 4;
        const lastR = pixels[lastIdx];
        const lastG = pixels[lastIdx + 1];
        const lastB = pixels[lastIdx + 2];
        if (lastR < BLACK_THRESHOLD && lastG < BLACK_THRESHOLD && lastB < BLACK_THRESHOLD) {
            for (let col = width - 1; col >= 0; col--) {
                const idx = rowStart + col * 4;
                const r = pixels[idx];
                const g = pixels[idx + 1];
                const b = pixels[idx + 2];
                if (r < BLACK_THRESHOLD && g < BLACK_THRESHOLD && b < BLACK_THRESHOLD) {
                    pixels[idx + 3] = 0;
                } else {
                    break;
                }
            }
        }
    }
}

function drawFrameToPano(panoCtx, image, x, y, crop, croppedWidth, croppedHeight, scaledFrameWidth, scaledFrameHeight, useMask, tempCanvas, tempCtx, maskImageData, frameWidth, frameHeight, rotation = 0, affine = null) {
    let sourceImage = image;
    
    if (exportWithEffects) {
        const effectsCanvas = document.createElement('canvas');
        effectsCanvas.width = frameWidth;
        effectsCanvas.height = frameHeight;
        const effectsCtx = effectsCanvas.getContext('2d');
        effectsCtx.filter = getVideoEffectsFilterString();
        effectsCtx.drawImage(image, 0, 0);
        effectsCtx.filter = 'none';
        applyVideoEffectsToCanvas(effectsCtx, frameWidth, frameHeight);
        sourceImage = effectsCanvas;
    }
    
    if (removeOuterBlack) {
        const blackCanvas = document.createElement('canvas');
        blackCanvas.width = frameWidth;
        blackCanvas.height = frameHeight;
        const blackCtx = blackCanvas.getContext('2d', {willReadFrequently: true});
        blackCtx.drawImage(sourceImage, 0, 0);
        const imgData = blackCtx.getImageData(0, 0, frameWidth, frameHeight);
        processRemoveOuterBlack(imgData);
        blackCtx.putImageData(imgData, 0, 0);
        sourceImage = blackCanvas;
    }
    
    const drawWithRotation = (src, sx, sy, sw, sh, dx, dy, dw, dh) => {
        if (affine) {
            // Full per-frame similarity (rotation + translation, off-center safe):
            // the affine maps native source pixels straight to panorama pixels.
            panoCtx.save();
            panoCtx.setTransform(affine[0], affine[3], affine[1], affine[4], affine[2], affine[5]);
            panoCtx.drawImage(src, 0, 0);
            panoCtx.restore();
        } else if (rotation !== 0) {
            panoCtx.save();
            panoCtx.translate(dx + dw / 2, dy + dh / 2);
            panoCtx.rotate(rotation);
            panoCtx.drawImage(src, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
            panoCtx.restore();
        } else {
            panoCtx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
        }
    };
    
    // Build a frame with masked-out (transparent) regions when either the redaction
    // mask is in use OR a crop border is requested. The "Panorama Crop" is applied
    // here as MASKING: the outer `crop`-px ring is set transparent (alpha 0), so the
    // full frame is still drawn at its true motion offset and the ignored border is
    // filled by neighbouring frames — instead of cutting the source geometry (which
    // left a hard, dark-sampled edge that produced the "edge-dropping" seams).
    const applyMask = (useMask && maskImageData) || crop > 0;
    if (applyMask) {
        tempCtx.clearRect(0, 0, frameWidth, frameHeight);
        tempCtx.drawImage(sourceImage, 0, 0);
        const frameImgData = tempCtx.getImageData(0, 0, frameWidth, frameHeight);
        const framePixels = frameImgData.data;
        const maskPixels = (useMask && maskImageData) ? maskImageData.data : null;
        const maskW = maskImageData ? maskImageData.width : frameWidth;
        const maskH = maskImageData ? maskImageData.height : frameHeight;
        const xHi = frameWidth - crop;
        const yHi = frameHeight - crop;

        for (let py = 0; py < frameHeight; py++) {
            const inCropY = py < crop || py >= yHi;
            for (let px = 0; px < frameWidth; px++) {
                // Masked if in the outer crop ring, or a redaction-mask pixel.
                let masked = inCropY || px < crop || px >= xHi;
                if (!masked && maskPixels && px < maskW && py < maskH) {
                    if (maskPixels[(py * maskW + px) * 4 + 3] > 128) masked = true;
                }
                if (masked) framePixels[(py * frameWidth + px) * 4 + 3] = 0;
            }
        }

        tempCtx.putImageData(frameImgData, 0, 0);
        drawWithRotation(tempCanvas, 0, 0, frameWidth, frameHeight, x, y, scaledFrameWidth, scaledFrameHeight);
    } else {
        drawWithRotation(sourceImage, 0, 0, frameWidth, frameHeight, x, y, scaledFrameWidth, scaledFrameHeight);
    }
}
let motionAnalyzer = null;
// updateOptimizeStatus and updateGuiValues live in CMotionAnalysisShared.js so
// CMotionAnalysis.js can import + call them without creating a circular dep
// (UI already imports from CMotionAnalysis). Assignments below use the setters.
let analyzeMenuItem = null;
let renderHooked = false;

export function resetMotionAnalysis() {
    if (motionAnalyzer) {
        motionAnalyzer.stop();
        motionAnalyzer = null;
    }
    removeParamSliders();
    renderHooked = false;
    if (analyzeMenuItem) {
        setMenuItemLabel(analyzeMenuItem, "menu.analyzeMotion.label");
    }
}

export async function toggleMotionAnalysis() {
    if (motionAnalyzer && motionAnalyzer.active) {
        // Signal any in-flight analysis / pano-export loop to bail at its next
        // poll, then tear down the live analysis. The running job's own finally
        // restores frame state and resets its label.
        panoCancelRequested = true;
        motionAnalyzer.stop();
        removeParamSliders();
        if (analyzeMenuItem) {
            setMenuItemLabel(analyzeMenuItem, "menu.analyzeMotion.label");
        }
        setRenderOne(true);
        return;
    }

    await ensureOpenCVAndAnalyzer(
        analyzeMenuItem,
        mt("status.loadingOpenCv"),
        mt("menu.analyzeMotion.label")
    );
}

let paramControllers = [];

// Registered with the shared module so CMotionAnalysis.js can invoke it
// without importing from this file directly (avoids circular dep).
function startAnalysis(videoView) {
    if (!motionAnalyzer) {
        motionAnalyzer = new MotionAnalyzer(videoView);
    }
    setMotionAnalyzerRef(motionAnalyzer);
    motionAnalyzer.start();
    
    if (analyzeMenuItem) {
        setMenuItemLabel(analyzeMenuItem, "status.stopAnalysis");
    }

    createParamSliders();

    if (!renderHooked) {
        renderHooked = true;
        const originalRender = videoView.renderCanvas.bind(videoView);
        videoView.renderCanvas = function(frame) {
            originalRender(frame);
            if (motionAnalyzer && motionAnalyzer.active) {
                motionAnalyzer.analyze(frame);
            }
        };
    }

    setRenderOne(true);
}
setStartAnalysis(startAnalysis);

// Lazily ensure a MotionAnalyzer and its mask overlay exist so that Masking is
// usable as soon as a video is loaded — WITHOUT starting a full motion-analysis
// pass. The persistent Masking menu (built in addMotionAnalysisMenu) routes every
// control through this. Returns the analyzer, or null if no video is loaded yet.
// If analysis is later started, startAnalysis() reuses this same instance.
function ensureMaskingAnalyzer() {
    const videoView = NodeMan.get("video", false);
    if (!videoView || !videoView.videoData) return null;
    if (!motionAnalyzer) {
        motionAnalyzer = new MotionAnalyzer(videoView);
        setMotionAnalyzerRef(motionAnalyzer);
    }
    motionAnalyzer.ensureMaskOverlay();
    return motionAnalyzer;
}

let motionFolder = null;
let motionTrackCounter = 0;
let createTrackMenuItem = null;
let exportMotionMenuItem = null;

// Lock so concurrent callers (e.g. both pano export menu items clicked in
// quick succession) coalesce onto a single analysis pass and just report
// progress, instead of each running their own polling loop and racing the
// par.frame / Globals.justVideoAnalysis state.
let analysisInProgress = null;

// Cooperative cancellation for long-running analysis + panorama jobs. Clicking
// "Stop Analysis" sets this flag (see toggleMotionAnalysis); every analysis /
// pano-export loop polls isPanoJobCancelled() and ends itself cleanly — restoring
// par.frame / par.paused, removing any progress overlay, and resetting its menu
// label — instead of being force-killed mid-frame. Each user-initiated job clears
// the flag at the start via beginPanoJob().
let panoCancelRequested = false;
function beginPanoJob() { panoCancelRequested = false; }
function isPanoJobCancelled() { return panoCancelRequested; }

function countCompleteInRange() {
    if (!motionAnalyzer) return 0;
    const aFrame = Sit.aFrame || 0;
    const bFrame = Sit.bFrame ?? (Sit.frames - 1);
    let n = 0;
    for (let f = aFrame; f <= bFrame; f++) {
        const c = motionAnalyzer.resultCache.get(f);
        if (c && !c.incomplete) n++;
    }
    return n;
}

function isMotionAnalysisReady() {
    if (!motionAnalyzer || !motionAnalyzer.isCacheFull()) return false;
    const aFrame = Sit.aFrame || 0;
    const bFrame = Sit.bFrame ?? (Sit.frames - 1);
    return motionAnalyzer.hasDuplicateFrameMapForRange(aFrame, bFrame);
}

function resetMotionAnalysisDerivedState(clearDuplicateMap = false) {
    if (!motionAnalyzer) return;

    for (const entry of motionAnalyzer.frameBuffer) {
        if (entry.gray) entry.gray.delete();
    }
    motionAnalyzer.resultCache.clear();
    if (clearDuplicateMap) motionAnalyzer.duplicateFrameCache.clear();
    motionAnalyzer.frameBuffer = [];
    motionAnalyzer.staticHistory.clear();
    motionAnalyzer.angleHistory = [];
    motionAnalyzer.smoothedDirection = {x: 0, y: 0, angle: 0, magnitude: 0, confidence: 0, rotation: 0};
    motionAnalyzer.lastFlowData = null;

    const videoData = motionAnalyzer.videoView?.videoData;
    motionAnalyzer.lastVideoDataId = videoData?.id || videoData?.filename || 'unknown';
    motionAnalyzer.lastAFrame = Sit.aFrame;
    motionAnalyzer.lastBFrame = Sit.bFrame;
}

function resetVideoThrashDetector(videoData) {
    if (!videoData) return;
    videoData.lastGetImageFrame = undefined;
    videoData.lastGetImageTime = undefined;
}

export async function scanDuplicateFramesForVideoExport(startFrame, endFrame, progress = null, expectedVideoData = null, options = {}) {
    const result = await ensureOpenCVAndAnalyzer(null, "", "");
    if (!result) return new Set();

    const {videoData} = result;
    if (expectedVideoData && expectedVideoData !== videoData) {
        console.warn("Unique-frame export is using the primary video view for duplicate detection; the requested videoData differs.");
    }

    const duplicateFrameSet = new Set();
    if (endFrame <= startFrame) return duplicateFrameSet;

    const savedPaused = par.paused;
    const savedFrame = par.frame;
    const savedJustVideoAnalysis = Globals.justVideoAnalysis;
    Globals.justVideoAnalysis = true;
    par.paused = true;

    try {
        const videoId = videoData?.id || videoData?.filename || "unknown";
        if (motionAnalyzer.lastVideoDataId !== videoId ||
            motionAnalyzer.lastAFrame !== Sit.aFrame ||
            motionAnalyzer.lastBFrame !== Sit.bFrame) {
            resetMotionAnalysisDerivedState(true);
        }

        motionAnalyzer.params.skipDuplicateFrames = true;

        if (!motionAnalyzer.hasDuplicateFrameMapForRange(startFrame, endFrame)) {
            resetVideoThrashDetector(videoData);
            await motionAnalyzer.buildDuplicateFrameMap(startFrame, endFrame, (current, total) => {
                progress?.update?.(current);
                if (progress?.setStatus) {
                    progress.setStatus(`Scanning duplicate video frames... ${Math.round(100 * current / total)}%`);
                }
            }, (frame) => {
                par.frame = frame;
                GlobalDateTimeNode?.update(frame);
            });
        }

        const meanAbsDiffThreshold = options.meanAbsDiffThreshold;
        for (let f = startFrame + 1; f <= endFrame; f++) {
            const duplicateInfo = motionAnalyzer.duplicateFrameCache.get(f);
            if (duplicateInfo?.isDuplicate ||
                (Number.isFinite(meanAbsDiffThreshold) && duplicateInfo?.meanAbsDiff <= meanAbsDiffThreshold)) {
                duplicateFrameSet.add(f);
            }
        }

        // Always keep the first exported frame, even if it duplicates the
        // frame immediately before the A-B range.
        duplicateFrameSet.delete(startFrame);
        return duplicateFrameSet;
    } finally {
        Globals.justVideoAnalysis = savedJustVideoAnalysis;
        par.paused = savedPaused;
        par.frame = savedFrame;
        GlobalDateTimeNode?.update(savedFrame);
        setRenderOne(true);
    }
}

function setMotionAnalysisProgressLabel(menuItem, progress, fallbackCurrent = null) {
    if (!menuItem) return;

    if (typeof progress === "number") {
        const total = fallbackCurrent ?? 1;
        const pct = total > 0 ? Math.round(100 * progress / total) : 0;
        setMenuItemLabel(menuItem, "status.analyzingPercent", {pct});
        return;
    }

    const pct = progress.pct ?? (progress.total > 0 ? Math.round(100 * progress.current / progress.total) : 0);
    const step = progress.step ?? 1;
    const steps = progress.steps ?? 1;

    switch (progress.phase) {
        case "duplicates":
            setMenuItemLabel(menuItem, "status.detectingDuplicatesPercent", {step, steps, pct});
            break;
        case "fallback":
            setMenuItemLabel(menuItem, "status.fillingMotionGapsPercent", {step, steps, pct});
            break;
        case "analysis":
        default:
            setMenuItemLabel(menuItem, "status.analyzingStepPercent", {step, steps, pct});
            break;
    }
}

async function analyzeAllFrames(progressCallback) {
    if (!motionAnalyzer) return false;

    const aFrame = Sit.aFrame || 0;
    const bFrame = Sit.bFrame ?? (Sit.frames - 1);
    const totalFrames = bFrame - aFrame + 1;

    // If another caller is already driving an analysis pass, just observe its
    // progress through our own callback and return when it finishes.
    if (analysisInProgress) {
        while (analysisInProgress && !isMotionAnalysisReady()) {
            if (isPanoJobCancelled()) break;
            if (progressCallback) progressCallback(countCompleteInRange(), totalFrames);
            await new Promise(r => setTimeout(r, 100));
        }
        if (progressCallback) progressCallback(countCompleteInRange(), totalFrames);
        return isMotionAnalysisReady();
    }

    const videoData = motionAnalyzer.videoView?.videoData;
    if (!videoData) return false;

    const savedPaused = par.paused;
    const savedFrame = par.frame;
    Globals.justVideoAnalysis = true;
    par.paused = true; // We drive frame advance ourselves below.

    let resolveDone;
    analysisInProgress = new Promise(r => (resolveDone = r));

    try {
        const skip = Math.max(1, Math.round(motionAnalyzer.params.frameSkip));
        if (motionAnalyzer.params.skipDuplicateFrames && !motionAnalyzer.hasDuplicateFrameMapForRange(aFrame, bFrame)) {
            const duplicateScanStart = Math.max(1, aFrame - Math.max(skip * 10, 30));
            motionAnalyzer.suspendAnalysis = true;
            resetMotionAnalysisDerivedState(true);
            resetVideoThrashDetector(videoData);
            await motionAnalyzer.buildDuplicateFrameMap(duplicateScanStart, bFrame, (current, total) => {
                progressCallback?.({
                    phase: "duplicates",
                    step: 1,
                    steps: 3,
                    current,
                    total,
                    pct: Math.round(100 * current / total),
                });
            }, (frame) => {
                par.frame = frame;
                GlobalDateTimeNode.update(frame);
            }, isPanoJobCancelled);

            // Re-run the selected range against the fixed virtual frame list,
            // but keep the duplicate map itself.
            resetMotionAnalysisDerivedState(false);
            motionAnalyzer.suspendAnalysis = false;
            resetVideoThrashDetector(videoData);

            // Stop cleanly if cancelled during the duplicate scan.
            if (isPanoJobCancelled()) return false;
        }

        // Preload the prev-context frames so the first `skip` frames of the
        // range can compute optical flow. Without this, analyze() marks them
        // incomplete (or skips them entirely when the play loop never visits
        // pre-aFrame frames), and isCacheFull() can never become true.
        for (let f = Math.max(0, aFrame - skip); f < aFrame; f++) {
            videoData.getImage(f);
        }
        for (let f = Math.max(0, aFrame - skip); f < aFrame; f++) {
            await videoData.waitForFrame(f, 5000);
        }

        // Two passes: the first walks every frame in order (so the analyzer's
        // frameBuffer is warm); the second retries anything still incomplete.
        const MAX_PASSES = 3;
        for (let pass = 0; pass < MAX_PASSES; pass++) {
            if (isPanoJobCancelled()) break;
            let stillMissing = 0;
            for (let f = aFrame; f <= bFrame; f++) {
                if (isPanoJobCancelled()) break;
                const cached = motionAnalyzer.resultCache.get(f);
                if (cached && !cached.incomplete) continue;

                videoData.getImage(f);
                await videoData.waitForFrame(f, 5000);
                par.frame = f;
                GlobalDateTimeNode.update(f);
                motionAnalyzer.analyze(f);
                await motionAnalyzer.fillBadNonDuplicateMotionGap(f, (frame) => {
                    par.frame = frame;
                    GlobalDateTimeNode.update(frame);
                });

                const after = motionAnalyzer.resultCache.get(f);
                if (!after || after.incomplete) stillMissing++;

                if (f % 5 === 0) {
                    const complete = countCompleteInRange();
                    progressCallback?.({
                        phase: "analysis",
                        step: 2,
                        steps: 3,
                        current: complete,
                        total: totalFrames,
                        pct: Math.round(100 * complete / totalFrames),
                    });
                    await new Promise(r => setTimeout(r, 0));
                }
            }
            const complete = countCompleteInRange();
            progressCallback?.({
                phase: "analysis",
                step: 2,
                steps: 3,
                current: complete,
                total: totalFrames,
                pct: Math.round(100 * complete / totalFrames),
            });
            if (stillMissing === 0) break;
        }

        if (isPanoJobCancelled()) return false;

        progressCallback?.({
            phase: "fallback",
            step: 3,
            steps: 3,
            current: 0,
            total: 1,
            pct: 0,
        });
        resetVideoThrashDetector(videoData);
        await motionAnalyzer.fillBadNonDuplicateMotionGaps(aFrame, bFrame, (frame) => {
            par.frame = frame;
            GlobalDateTimeNode.update(frame);
        }, (current, total) => {
            progressCallback?.({
                phase: "fallback",
                step: 3,
                steps: 3,
                current,
                total,
                pct: Math.round(100 * current / total),
            });
        }, isPanoJobCancelled);
        progressCallback?.({
            phase: "fallback",
            step: 3,
            steps: 3,
            current: 1,
            total: 1,
            pct: 100,
        });

        return isPanoJobCancelled() ? false : isMotionAnalysisReady();
    } finally {
        if (motionAnalyzer) motionAnalyzer.suspendAnalysis = false;
        par.paused = savedPaused;
        par.frame = savedFrame;
        Globals.justVideoAnalysis = false;
        resolveDone();
        analysisInProgress = null;
    }
}

async function createTrackFromMotion() {
    const result = await ensureOpenCVAndAnalyzer(
        createTrackMenuItem,
        mt("status.loadingOpenCv"),
        mt("menu.createTrack.label")
    );
    if (!result) return;

    setMenuItemLabel(createTrackMenuItem, "status.analyzingPercent", {pct: 0});
    
    await analyzeAllFrames((progress, total) => {
        setMotionAnalysisProgressLabel(createTrackMenuItem, progress, total);
    });

    setMenuItemLabel(createTrackMenuItem, "status.creatingTrack");

    const originNode = NodeMan.get("LOSTraverseSelect", false) 
        ?? NodeMan.get("targetTrack", false)
        ?? NodeMan.get("cameraTrack", false);
    
    if (!originNode) {
        alert(mt("errors.noOriginTrack"));
        setMenuItemLabel(createTrackMenuItem, "menu.createTrack.label");
        return;
    }

    const fovNode = NodeMan.get("fov", false) ?? NodeMan.get("cameraFOV", false);
    const fovDegrees = fovNode ? fovNode.v(0) : 30;
    const dims = motionAnalyzer.getImageDimensions();

    const distanceNode = NodeMan.get("targetDistance", false);
    const distance = distanceNode ? distanceNode.v(0) : 1000;

    const fovRadians = fovDegrees * Math.PI / 180;
    const imageWidthMeters = 2 * distance * Math.tan(fovRadians / 2);
    const metersPerPixel = imageWidthMeters / dims.width;

    // Track creation wants a smooth curve: gap-fill interpolates over
    // low-quality frames so the synthesized velocity track stays continuous.
    const motionData = motionAnalyzer.getMotionDataForAllFrames();

    motionTrackCounter++;
    const suffix = motionTrackCounter > 1 ? `_${motionTrackCounter}` : "";
    const velocityId = `motionVelocity${suffix}`;
    const trackId = `motionTrack${suffix}`;
    const displayId = `motionTrackDisplay${suffix}`;

    if (NodeMan.exists(velocityId)) NodeMan.disposeRemove(velocityId);
    if (NodeMan.exists(trackId)) NodeMan.disposeRemove(trackId);
    if (NodeMan.exists(displayId)) NodeMan.disposeRemove(displayId);

    new CNodeVelocityFromMotion({
        id: velocityId,
        motionData: motionData,
        metersPerPixel: metersPerPixel,
        frames: Sit.frames,
    });

    new CNodeTrackFromVelocity({
        id: trackId,
        origin: originNode.id,
        velocity: velocityId,
        agl: 1,
        frames: Sit.frames,
    });

    new CNodeDisplayTrack({
        id: displayId,
        track: trackId,
        color: new Color(0.2, 0.8, 0.2),
        width: 2,
    });

    setMenuItemLabel(createTrackMenuItem, "menu.createTrack.label");
    setRenderOne(true);
    console.log(`Created motion track '${trackId}' from ${motionAnalyzer.resultCache.size} analyzed frames, ${metersPerPixel.toFixed(3)} m/px`);
}

async function exportMotionCSV() {
    const result = await ensureOpenCVAndAnalyzer(
        exportMotionMenuItem,
        mt("status.loadingOpenCv"),
        mt("menu.exportMotion.label")
    );
    if (!result) return;

    if (!isMotionAnalysisReady()) {
        setMenuItemLabel(exportMotionMenuItem, "status.analyzingPercent", {pct: 0});
        await analyzeAllFrames((progress, total) => {
            setMotionAnalysisProgressLabel(exportMotionMenuItem, progress, total);
        });
    }

    setMenuItemLabel(exportMotionMenuItem, "status.saving");

    const aFrame = Sit.aFrame || 0;
    const bFrame = Sit.bFrame ?? (Sit.frames - 1);
    const fps = Sit.fps || 30;

    const lines = ["frame,angle_deg,magnitude_px,time_sec,utc_time"];
    for (let f = aFrame; f <= bFrame; f++) {
        const cached = motionAnalyzer.resultCache.get(f);
        let angleDeg = 0;
        let magnitude = 0;
        if (cached && cached.smoothedDirection) {
            const sd = cached.smoothedDirection;
            angleDeg = ((sd.angle * 180 / Math.PI) + 360) % 360;
            magnitude = sd.magnitude;
        }
        const timeSec = f / fps;
        const utc = GlobalDateTimeNode ? GlobalDateTimeNode.frameToDate(f).toISOString() : "";
        lines.push(`${f},${angleDeg.toFixed(4)},${magnitude.toFixed(4)},${timeSec.toFixed(4)},${utc}`);
    }

    const csv = lines.join("\n") + "\n";
    const blob = new Blob([csv], {type: "text/csv"});
    const filename = `${getExportPrefix()}_motion_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.csv`;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);

    console.log(`Motion CSV exported: ${filename} (${bFrame - aFrame + 1} frames)`);
    setMenuItemLabel(exportMotionMenuItem, "menu.exportMotion.label");
}

// MAX_PANORAMA_DIM/AREA, PANO_VIDEO_4K_*, exportWithEffects, removeOuterBlack,
// panoCrop, useMaskInPano and panoFrameStep are declared at the top of this
// file (the helpers extracted from calculatePanoDimensions / drawFrameToPano
// use them before this block).
let exportPanoMenuItem = null;
let exportFeaturePanoMenuItem = null;
let exportFeaturePanoVideoMenuItem = null;
let exportPanoVideoMenuItem = null;
let stabilizeMenuItem = null;
let stabilizationEnabled = false;

async function exportMotionPanorama() {
    beginPanoJob();
    const result = await ensureOpenCVAndAnalyzer(
        exportPanoMenuItem,
        mt("status.loadingOpenCv"),
        mt("menu.panorama.exportImage.label")
    );
    if (!result) return;
    const {videoData} = result;

    if (!isMotionAnalysisReady()) {
        setMenuItemLabel(exportPanoMenuItem, "status.analyzingPercent", {pct: 0});
        const ready = await analyzeAllFrames((progress, total) => {
            setMotionAnalysisProgressLabel(exportPanoMenuItem, progress, total);
        });
        if (!ready) {
            console.warn("Motion panorama export aborted: motion analysis did not complete for the selected range");
            setMenuItemLabel(exportPanoMenuItem, "menu.panorama.exportImage.label");
            return;
        }
    }

    setMenuItemLabel(exportPanoMenuItem, "status.buildingPanorama");

    const startFrame = Sit.aFrame;
    const endFrame = Sit.bFrame;
    const crop = panoCrop;
    resetVideoThrashDetector(videoData);
    await motionAnalyzer.fillBadNonDuplicateMotionGaps(startFrame, endFrame, (frame) => {
        par.frame = frame;
        GlobalDateTimeNode.update(frame);
    }, null, isPanoJobCancelled);
    const motionData = motionAnalyzer.getMotionDataForAllFrames({gapFill: false, fallbackToSmoothed: false, useTrackletLastSegment: true});

    const panoRotation = isAlignWithFlowEnabled() ? -calculateOverallMotionAngle(motionData, startFrame, endFrame) : 0;
    const {frameData, totalFrames, frameWidth, frameHeight, croppedWidth, croppedHeight, panoWidthPx, panoHeightPx, scale, scaledFrameWidth, scaledFrameHeight} =
        computePanoLayout(videoData, motionData, startFrame, endFrame, panoFrameStep, crop, panoRotation);

    const panoCanvas = document.createElement('canvas');
    panoCanvas.width = panoWidthPx;
    panoCanvas.height = panoHeightPx;
    const panoCtx = panoCanvas.getContext('2d');

    panoCtx.fillStyle = 'black';
    panoCtx.fillRect(0, 0, panoWidthPx, panoHeightPx);

    const useMask = useMaskInPano && motionAnalyzer.maskEnabled && motionAnalyzer.maskOverlayNode && motionAnalyzer.maskOverlayNode.maskCanvas;
    let tempCanvas = null;
    let tempCtx = null;
    let maskImageData = null;

    // tempCanvas is needed whenever we build a masked frame — for the redaction mask
    // and/or the crop border (which is applied as masking, not by cutting geometry).
    if (useMask || crop > 0) {
        tempCanvas = document.createElement('canvas');
        tempCanvas.width = frameWidth;
        tempCanvas.height = frameHeight;
        tempCtx = tempCanvas.getContext('2d', {willReadFrequently: true});
    }
    if (useMask) {
        motionAnalyzer.maskOverlayNode.updateMaskImageData();
        maskImageData = motionAnalyzer.maskOverlayNode.maskImageData;
    }

    const previewOverlay = document.createElement('div');
    previewOverlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:#000;z-index:9999;display:flex;align-items:center;justify-content:center;flex-direction:column;';
    
    const previewCanvas = document.createElement('canvas');
    const previewAspect = panoWidthPx / panoHeightPx;
    const maxPreviewWidth = window.innerWidth * 0.95;
    const maxPreviewHeight = window.innerHeight * 0.85;
    if (maxPreviewWidth / maxPreviewHeight > previewAspect) {
        previewCanvas.height = maxPreviewHeight;
        previewCanvas.width = maxPreviewHeight * previewAspect;
    } else {
        previewCanvas.width = maxPreviewWidth;
        previewCanvas.height = maxPreviewWidth / previewAspect;
    }
    previewCanvas.style.border = '2px solid #444';
    const previewCtx = previewCanvas.getContext('2d');
    
    const statusText = document.createElement('div');
    statusText.style.cssText = 'color:#fff;font-size:18px;margin-top:15px;font-family:sans-serif;';
    statusText.textContent = mt("status.buildingPanoramaPercent", {pct: 0});
    
    previewOverlay.appendChild(previewCanvas);
    previewOverlay.appendChild(statusText);
    document.body.appendChild(previewOverlay);

    Globals.justVideoAnalysis = true;
    const savedPaused = par.paused;
    const savedFrame = par.frame;
    par.paused = true;
    const previewEveryNFrames = 20;
    
    const updatePreview = () => {
        previewCtx.drawImage(panoCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
    };
    
    let skippedFrames = 0;
    let cancelledExport = false;
    for (let i = 0; i < totalFrames; i++) {
        if (isPanoJobCancelled()) { cancelledExport = true; break; }
        const fd = frameData[i];

        statusText.textContent = mt("status.loadingFrame", {
            current: i + 1,
            frame: fd.frame,
            total: totalFrames,
        });
        
        par.frame = fd.frame;
        GlobalDateTimeNode.update(fd.frame);

        videoData.getImage(fd.frame);
        const loaded = await videoData.waitForFrame(fd.frame, 5000);
        if (!loaded) {
            console.warn(`Failed to load frame ${fd.frame}, skipping`);
            skippedFrames++;
            continue;
        }
        
        const image = videoData.getImageNoPurge(fd.frame);
        if (!image || !image.width) {
            skippedFrames++;
            continue;
        }

        drawFrameToPano(panoCtx, image, fd.x, fd.y, crop, croppedWidth, croppedHeight, scaledFrameWidth, scaledFrameHeight, useMask, tempCanvas, tempCtx, maskImageData, frameWidth, frameHeight, panoRotation, fd.affine);

        if (i % previewEveryNFrames === 0) {
            const pct = Math.round(100 * i / totalFrames);
            updatePreview();
            statusText.textContent = skippedFrames > 0
                ? mt("status.loadingFrameSkipped", {
                    current: i + 1,
                    frame: fd.frame,
                    skipped: skippedFrames,
                    total: totalFrames,
                })
                : mt("status.loadingFrame", {
                    current: i + 1,
                    frame: fd.frame,
                    total: totalFrames,
                });
            setMenuItemLabel(exportPanoMenuItem, "status.renderingPercent", {pct});
            await new Promise(r => setTimeout(r, 0));
        }
    }

    Globals.justVideoAnalysis = false;
    par.paused = savedPaused;
    par.frame = savedFrame;

    if (cancelledExport) {
        console.log("Motion panorama export cancelled");
        document.body.removeChild(previewOverlay);
        setMenuItemLabel(exportPanoMenuItem, "menu.panorama.exportImage.label");
        setRenderOne(true);
        return;
    }

    updatePreview();
    statusText.textContent = mt("status.saving");

    setMenuItemLabel(exportPanoMenuItem, "status.saving");

    panoCanvas.toBlob((blob) => {
        const filename = `${getExportPrefix()}_motion_panorama_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        
        console.log(`Motion panorama exported: ${filename}`);
        setMenuItemLabel(exportPanoMenuItem, "menu.panorama.exportImage.label");

        document.body.removeChild(previewOverlay);
    }, 'image/png');
}

// "Export Feature Pano" (Image + Video) — a separate, perspective-aware panorama
// path that registers frames with industry-standard feature matching + warping
// (see FeaturePanoramaExporter.js) instead of the optical-flow translation used by
// Export Motion Panorama. It needs OpenCV + a video, but NOT a completed
// motion-analysis pass (it does its own registration). Uses the Feature Pano
// Options (frame step / crop / mask / projection).
function featurePanoOptions(videoData) {
    const useMask = panoFeatureUseMask && motionAnalyzer.maskEnabled
        && motionAnalyzer.maskOverlayNode && motionAnalyzer.maskOverlayNode.maskCanvas;
    let maskImageData = null;
    if (useMask) {
        motionAnalyzer.maskOverlayNode.updateMaskImageData();
        maskImageData = motionAnalyzer.maskOverlayNode.maskImageData;
    }
    return {
        cv: getCV(),
        videoData,
        startFrame: Sit.aFrame,
        endFrame: Sit.bFrame,
        frameStep: panoFeatureFrameStep,
        crop: panoFeatureCrop,
        useMask,
        maskImageData,
        projection: panoFeatureProjection,
        t: (key, opts) => mt(key, opts),
    };
}

async function exportFeaturePano() {
    beginPanoJob();
    const result = await ensureOpenCVAndAnalyzer(
        exportFeaturePanoMenuItem,
        mt("status.loadingOpenCv"),
        mt("menu.panorama.exportFeature.label")
    );
    if (!result) return;
    const {exportFeaturePanorama} = await import("./FeaturePanoramaExporter");
    await exportFeaturePanorama({
        ...featurePanoOptions(result.videoData),
        setMenuLabel: (key, opts) => setMenuItemLabel(exportFeaturePanoMenuItem, key, opts),
        doneLabel: "menu.panorama.exportFeature.label",
        shouldCancel: isPanoJobCancelled,
    });
}

async function exportFeaturePanoVideo() {
    beginPanoJob();
    const result = await ensureOpenCVAndAnalyzer(
        exportFeaturePanoVideoMenuItem,
        mt("status.loadingOpenCv"),
        mt("menu.panorama.exportFeatureVideo.label")
    );
    if (!result) return;
    const {exportFeaturePanoramaVideo} = await import("./FeaturePanoramaExporter");
    await exportFeaturePanoramaVideo({
        ...featurePanoOptions(result.videoData),
        setMenuLabel: (key, opts) => setMenuItemLabel(exportFeaturePanoVideoMenuItem, key, opts),
        doneLabel: "menu.panorama.exportFeatureVideo.label",
        shouldCancel: isPanoJobCancelled,
    });
}

async function exportPanoVideo() {
    beginPanoJob();
    const result = await ensureOpenCVAndAnalyzer(
        exportPanoVideoMenuItem,
        mt("status.loadingOpenCv"),
        mt("menu.panorama.exportVideo.label")
    );
    if (!result) return;
    const {videoData} = result;

    if (!isMotionAnalysisReady()) {
        setMenuItemLabel(exportPanoVideoMenuItem, "status.analyzingPercent", {pct: 0});
        const ready = await analyzeAllFrames((progress, total) => {
            setMotionAnalysisProgressLabel(exportPanoVideoMenuItem, progress, total);
        });
        if (!ready) {
            console.warn("Motion pano video export aborted: motion analysis did not complete for the selected range");
            setMenuItemLabel(exportPanoVideoMenuItem, "menu.panorama.exportVideo.label");
            return;
        }
    }

    setMenuItemLabel(exportPanoVideoMenuItem, "status.buildingPanorama");

    const startFrame = Sit.aFrame;
    const endFrame = Sit.bFrame;
    const crop = panoCrop;
    resetVideoThrashDetector(videoData);
    await motionAnalyzer.fillBadNonDuplicateMotionGaps(startFrame, endFrame, (frame) => {
        par.frame = frame;
        GlobalDateTimeNode.update(frame);
    }, null, isPanoJobCancelled);
    const motionData = motionAnalyzer.getMotionDataForAllFrames({gapFill: false, fallbackToSmoothed: false, useTrackletLastSegment: true});

    const panoRotation = isAlignWithFlowEnabled() ? -calculateOverallMotionAngle(motionData, startFrame, endFrame) : 0;
    const {frameData, totalFrames, frameWidth, frameHeight, croppedWidth, croppedHeight, panoWidthPx, panoHeightPx, scale: panoScale, scaledFrameWidth, scaledFrameHeight} =
        computePanoLayout(videoData, motionData, startFrame, endFrame, 1, crop, panoRotation);

    const panoCanvas = document.createElement('canvas');
    panoCanvas.width = panoWidthPx;
    panoCanvas.height = panoHeightPx;
    const panoCtx = panoCanvas.getContext('2d');

    panoCtx.fillStyle = 'black';
    panoCtx.fillRect(0, 0, panoWidthPx, panoHeightPx);

    const useMask = useMaskInPano && motionAnalyzer.maskEnabled && motionAnalyzer.maskOverlayNode && motionAnalyzer.maskOverlayNode.maskCanvas;
    let tempCanvas = null;
    let tempCtx = null;
    let maskImageData = null;

    // tempCanvas is needed whenever we build a masked frame — for the redaction mask
    // and/or the crop border (which is applied as masking, not by cutting geometry).
    if (useMask || crop > 0) {
        tempCanvas = document.createElement('canvas');
        tempCanvas.width = frameWidth;
        tempCanvas.height = frameHeight;
        tempCtx = tempCanvas.getContext('2d', {willReadFrequently: true});
    }
    if (useMask) {
        motionAnalyzer.maskOverlayNode.updateMaskImageData();
        maskImageData = motionAnalyzer.maskOverlayNode.maskImageData;
    }

    Globals.justVideoAnalysis = true;
    const savedPaused = par.paused;
    const savedFrame = par.frame;
    par.paused = true;
    
    for (let i = 0; i < totalFrames; i++) {
        if (isPanoJobCancelled()) break;
        const fd = frameData[i];

        par.frame = fd.frame;
        GlobalDateTimeNode.update(fd.frame);

        videoData.getImage(fd.frame);
        const loaded = await videoData.waitForFrame(fd.frame, 5000);
        if (!loaded) continue;

        const image = videoData.getImageNoPurge(fd.frame);
        if (!image || !image.width) continue;

        drawFrameToPano(panoCtx, image, fd.x, fd.y, crop, croppedWidth, croppedHeight, scaledFrameWidth, scaledFrameHeight, useMask, tempCanvas, tempCtx, maskImageData, frameWidth, frameHeight, panoRotation, fd.affine);

        if (i % 20 === 0) {
            const pct = Math.round(100 * i / totalFrames);
            setMenuItemLabel(exportPanoVideoMenuItem, "status.panoPercent", {pct});
            await new Promise(r => setTimeout(r, 0));
        }
    }

    if (isPanoJobCancelled()) {
        console.log("Pano video export cancelled");
        Globals.justVideoAnalysis = false;
        par.paused = savedPaused;
        par.frame = savedFrame;
        setMenuItemLabel(exportPanoVideoMenuItem, "menu.panorama.exportVideo.label");
        setRenderOne(true);
        return;
    }

    setMenuItemLabel(exportPanoVideoMenuItem, "status.renderingVideo");

    const outputWidth = PANO_VIDEO_4K_WIDTH;
    const outputHeight = PANO_VIDEO_4K_HEIGHT;

    const panoAspect = panoWidthPx / panoHeightPx;
    const outputAspect = outputWidth / outputHeight;

    let fitWidth, fitHeight, offsetX, offsetY;
    if (panoAspect > outputAspect) {
        fitWidth = outputWidth;
        fitHeight = Math.round(outputWidth / panoAspect);
        offsetX = 0;
        offsetY = Math.round((outputHeight - fitHeight) / 2);
    } else {
        fitHeight = outputHeight;
        fitWidth = Math.round(outputHeight * panoAspect);
        offsetX = Math.round((outputWidth - fitWidth) / 2);
        offsetY = 0;
    }

    const videoFrameScaleX = fitWidth / panoWidthPx;
    const videoFrameScaleY = fitHeight / panoHeightPx;
    const videoFrameWidth = Math.round(scaledFrameWidth * videoFrameScaleX);
    const videoFrameHeight = Math.round(scaledFrameHeight * videoFrameScaleY);

    const {createVideoExporter, getVideoExtension, getBestFormatForResolution, checkVideoEncodingSupport} = await import("./VideoExporter");

    const encodingSupport = await checkVideoEncodingSupport();
    if (!encodingSupport.supported) {
        alert(mt("errors.videoEncodingUnsupported"));
        Globals.justVideoAnalysis = false;
        par.paused = savedPaused;
        setMenuItemLabel(exportPanoVideoMenuItem, "menu.panorama.exportVideo.label");
        return;
    }

    const formatId = encodingSupport.h264 ? 'mp4-h264' : 'webm-vp8';
    const bestFormat = await getBestFormatForResolution(formatId, outputWidth, outputHeight);
    if (!bestFormat.formatId) {
        alert(mt("errors.exportFailed", {reason: bestFormat.reason}));
        Globals.justVideoAnalysis = false;
        par.paused = savedPaused;
        setMenuItemLabel(exportPanoVideoMenuItem, "menu.panorama.exportVideo.label");
        return;
    }

    const extension = getVideoExtension(bestFormat.formatId);
    const fps = Sit.fps;

    const progress = new ExportProgressWidget(mt("status.exportProgressTitle"), totalFrames);

    const compositeCanvas = document.createElement('canvas');
    compositeCanvas.width = outputWidth;
    compositeCanvas.height = outputHeight;
    const compositeCtx = compositeCanvas.getContext('2d');

    try {
        const exporter = await createVideoExporter(bestFormat.formatId, {
            width: outputWidth,
            height: outputHeight,
            fps,
            bitrate: 20_000_000,
            keyFrameInterval: 30,
            hardwareAcceleration: bestFormat.hardwareAcceleration,
        });

        await exporter.initialize();

        for (let i = 0; i < totalFrames; i++) {
            if (progress.shouldStop() || isPanoJobCancelled()) break;

            const fd = frameData[i];
            par.frame = fd.frame;
            GlobalDateTimeNode.update(fd.frame);

            videoData.getImage(fd.frame);
            const loaded = await videoData.waitForFrame(fd.frame, 5000);
            if (!loaded) continue;

            const image = videoData.getImageNoPurge(fd.frame);
            if (!image || !image.width) continue;

            compositeCtx.fillStyle = 'black';
            compositeCtx.fillRect(0, 0, outputWidth, outputHeight);

            compositeCtx.drawImage(panoCanvas, offsetX, offsetY, fitWidth, fitHeight);

            const frameX = offsetX + fd.x * videoFrameScaleX;
            const frameY = offsetY + fd.y * videoFrameScaleY;

            let overlayImage = image;
            if (exportWithEffects) {
                const effectsCanvas = document.createElement('canvas');
                effectsCanvas.width = frameWidth;
                effectsCanvas.height = frameHeight;
                const effectsCtx = effectsCanvas.getContext('2d');
                effectsCtx.filter = getVideoEffectsFilterString();
                effectsCtx.drawImage(image, 0, 0);
                effectsCtx.filter = 'none';
                applyVideoEffectsToCanvas(effectsCtx, frameWidth, frameHeight);
                overlayImage = effectsCanvas;
            }

            if (removeOuterBlack) {
                const blackCanvas = document.createElement('canvas');
                blackCanvas.width = frameWidth;
                blackCanvas.height = frameHeight;
                const blackCtx = blackCanvas.getContext('2d', {willReadFrequently: true});
                blackCtx.drawImage(overlayImage, 0, 0);
                const imgData = blackCtx.getImageData(0, 0, frameWidth, frameHeight);
                processRemoveOuterBlack(imgData);
                blackCtx.putImageData(imgData, 0, 0);
                overlayImage = blackCanvas;
            }

            if (fd.affine) {
                // Rotate-frames mode: map native source -> panorama -> 4K composite.
                const C = [videoFrameScaleX, 0, offsetX, 0, videoFrameScaleY, offsetY, 0, 0, 1];
                const A = pmul3(C, fd.affine);
                compositeCtx.save();
                compositeCtx.setTransform(A[0], A[3], A[1], A[4], A[2], A[5]);
                compositeCtx.drawImage(overlayImage, 0, 0);
                compositeCtx.restore();
            } else if (panoRotation !== 0) {
                compositeCtx.save();
                compositeCtx.translate(frameX + videoFrameWidth / 2, frameY + videoFrameHeight / 2);
                compositeCtx.rotate(panoRotation);
                compositeCtx.drawImage(
                    overlayImage,
                    0, 0, croppedWidth, croppedHeight,
                    -videoFrameWidth / 2, -videoFrameHeight / 2, videoFrameWidth, videoFrameHeight
                );
                compositeCtx.restore();
            } else {
                compositeCtx.drawImage(
                    overlayImage,
                    0, 0, croppedWidth, croppedHeight,
                    frameX, frameY, videoFrameWidth, videoFrameHeight
                );
            }

            await exporter.addFrame(compositeCanvas, fd.frame);

            if (i % 10 === 0) {
                progress.update(i + 1);
                const pct = Math.round(100 * i / totalFrames);
                setMenuItemLabel(exportPanoVideoMenuItem, "status.videoPercent", {pct});
                await new Promise(r => setTimeout(r, 0));
            }
        }

        if (progress.shouldSave() && !isPanoJobCancelled()) {
            const blob = await exporter.finalize(
                (current, total) => progress.setFinalizeProgress(current, total),
                (status) => progress.setStatus(status)
            );

            const filename = `pano_video_${Sit.name || 'export'}_${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.${extension}`;
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            a.click();
            URL.revokeObjectURL(url);

            console.log(`Pano video exported: ${filename}`);
        }

    } catch (e) {
        console.error('Pano video export failed:', e);
        alert(mt("errors.panoVideoExportFailed", {message: e.message}));
    } finally {
        progress.remove();
        par.frame = savedFrame;
        Globals.justVideoAnalysis = false;
        par.paused = savedPaused;
        setMenuItemLabel(exportPanoVideoMenuItem, "menu.panorama.exportVideo.label");
        setRenderOne(true);
    }
}

async function stabilizeVideoFromMotion() {
    const result = await ensureOpenCVAndAnalyzer(
        stabilizeMenuItem,
        mt("status.loadingOpenCv"),
        mt("menu.panorama.stabilize.label")
    );
    if (!result) return;
    const {videoData} = result;

    if (!isMotionAnalysisReady()) {
        setMenuItemLabel(stabilizeMenuItem, "status.analyzingPercent", {pct: 0});
        await analyzeAllFrames((progress, total) => {
            setMotionAnalysisProgressLabel(stabilizeMenuItem, progress, total);
        });
    }

    setMenuItemLabel(stabilizeMenuItem, "status.buildingStabilization");

    const motionData = motionAnalyzer.getMotionDataForAllFrames({gapFill: false});

    // Calculate cumulative offsets from per-frame motion vectors
    // This reverses the camera motion to stabilize the video
    const stabilizationData = new Map();
    let cumX = 0, cumY = 0;

    for (let f = 0; f < motionData.length; f++) {
        // Negate motion to cancel it out (same logic as panorama)
        cumX -= motionData[f].dx;
        cumY -= motionData[f].dy;
        stabilizationData.set(f, {x: cumX, y: cumY});
    }

    // For full-frame stabilization, reference point is (0,0)
    // and we use direct offset mode
    const referencePoint = {x: 0, y: 0};

    videoData.setStabilizationData(stabilizationData, referencePoint, true); // true = direct offset mode
    videoData.setStabilizationEnabled(true);
    stabilizationEnabled = true;

    setMenuItemLabel(stabilizeMenuItem, "menu.panorama.stabilize.disableLabel");
    console.log(`Video stabilization enabled with ${stabilizationData.size} frames of motion data`);
}

function toggleStabilization() {
    const videoView = NodeMan.get("video", false);
    if (!videoView || !videoView.videoData) return;

    if (stabilizationEnabled) {
        videoView.videoData.setStabilizationEnabled(false);
        stabilizationEnabled = false;
        setMenuItemLabel(stabilizeMenuItem, "menu.panorama.stabilize.label");
        console.log("Video stabilization disabled");
    } else {
        // If we have cached motion data, re-enable; otherwise run full analysis
        if (videoView.videoData.stabilizationData && videoView.videoData.stabilizationData.size > 0) {
            videoView.videoData.setStabilizationEnabled(true);
            stabilizationEnabled = true;
            setMenuItemLabel(stabilizeMenuItem, "menu.panorama.stabilize.disableLabel");
            console.log("Video stabilization re-enabled");
        } else {
            stabilizeVideoFromMotion();
        }
    }
}

export function addMotionAnalysisMenu() {
    if (!guiMenus.view) return;
    
    motionFolder = guiMenus.video.addFolder(mt("menu.title")).close().perm();
    
    const menuActions = {
        analyzeMotion: toggleMotionAnalysis,
        createTrack: createTrackFromMotion,
        exportMotion: exportMotionCSV,
        exportPanorama: exportMotionPanorama,
        exportPanoVideo: exportPanoVideo,
        exportFeaturePano: exportFeaturePano,
        exportFeaturePanoVideo: exportFeaturePanoVideo,
        stabilizeVideo: toggleStabilization,
    };

    analyzeMenuItem = motionFolder.add(menuActions, 'analyzeMotion')
        .name(mt("menu.analyzeMotion.label"))
        .tooltip(mt("menu.analyzeMotion.tooltip"))
        .perm();

    createTrackMenuItem = motionFolder.add(menuActions, 'createTrack')
        .name(mt("menu.createTrack.label"))
        .tooltip(mt("menu.createTrack.tooltip"))
        .perm();

    exportMotionMenuItem = motionFolder.add(menuActions, 'exportMotion')
        .name(mt("menu.exportMotion.label"))
        .tooltip(mt("menu.exportMotion.tooltip"))
        .perm();

    const flowParams = {
        get alignWithFlow() { return isAlignWithFlowEnabled(); },
        set alignWithFlow(v) {
            setAlignWithFlow(v);
            setRenderOne(true);
        }
    };
    motionFolder.add(flowParams, 'alignWithFlow')
        .name(mt("menu.alignWithFlow.label"))
        .tooltip(mt("menu.alignWithFlow.tooltip"))
        .perm();

    // Stabilize Video lives at the Motion Analysis level (not under Panorama).
    stabilizeMenuItem = motionFolder.add(menuActions, 'stabilizeVideo')
        .name(mt("menu.panorama.stabilize.label"))
        .tooltip(mt("menu.panorama.stabilize.tooltip"))
        .perm();

    const panoFolder = motionFolder.addFolder(mt("menu.panorama.title")).close().perm();

    // --- Motion pano (optical-flow translation) ---
    exportPanoMenuItem = panoFolder.add(menuActions, 'exportPanorama')
        .name(mt("menu.panorama.exportImage.label"))
        .tooltip(mt("menu.panorama.exportImage.tooltip"))
        .perm();

    exportPanoVideoMenuItem = panoFolder.add(menuActions, 'exportPanoVideo')
        .name(mt("menu.panorama.exportVideo.label"))
        .tooltip(mt("menu.panorama.exportVideo.tooltip"))
        .perm();

    const motionPanoParams = {
        get panoCrop() { return panoCrop; }, set panoCrop(v) { panoCrop = v; },
        get useMaskInPano() { return useMaskInPano; }, set useMaskInPano(v) { useMaskInPano = v; },
        get panoFrameStep() { return panoFrameStep; }, set panoFrameStep(v) { panoFrameStep = v; },
        // analyzeWithEffects lives in CMotionAnalysis.js (read by imageToGrayscale
        // which remains there with the class). Bridge via the exported setter.
        get analyzeWithEffects() { return getAnalyzeWithEffects(); }, set analyzeWithEffects(v) { setAnalyzeWithEffects(v); },
        get exportWithEffects() { return exportWithEffects; }, set exportWithEffects(v) { exportWithEffects = v; },
        get removeOuterBlack() { return removeOuterBlack; }, set removeOuterBlack(v) { removeOuterBlack = v; },
        get rotateFrames() { return panoRotateFrames; }, set rotateFrames(v) { panoRotateFrames = v; },
        get allowFrameScale() { return panoAllowFrameScale; }, set allowFrameScale(v) { panoAllowFrameScale = v; }
    };
    const motionOptions = panoFolder.addFolder(mt("menu.panorama.motionOptions.title")).close().perm();
    motionOptions.add(motionPanoParams, 'rotateFrames')
        .name(mt("menu.panorama.rotateFrames.label"))
        .tooltip(mt("menu.panorama.rotateFrames.tooltip")).perm();
    motionOptions.add(motionPanoParams, 'allowFrameScale')
        .name(mt("menu.panorama.allowFrameScale.label"))
        .tooltip(mt("menu.panorama.allowFrameScale.tooltip")).perm();
    motionOptions.add(motionPanoParams, 'panoFrameStep', 1, 60, 1)
        .name(mt("menu.panorama.panoFrameStep.label"))
        .tooltip(mt("menu.panorama.panoFrameStep.tooltip")).perm();
    motionOptions.add(motionPanoParams, 'panoCrop', 0, 100, 1)
        .name(mt("menu.panorama.crop.label"))
        .tooltip(mt("menu.panorama.crop.tooltip")).perm();
    motionOptions.add(motionPanoParams, 'useMaskInPano')
        .name(mt("menu.panorama.useMask.label"))
        .tooltip(mt("menu.panorama.useMask.tooltip")).perm();
    motionOptions.add(motionPanoParams, 'analyzeWithEffects')
        .name(mt("menu.panorama.analyzeWithEffects.label"))
        .tooltip(mt("menu.panorama.analyzeWithEffects.tooltip")).perm();
    motionOptions.add(motionPanoParams, 'exportWithEffects')
        .name(mt("menu.panorama.exportWithEffects.label"))
        .tooltip(mt("menu.panorama.exportWithEffects.tooltip")).perm();
    motionOptions.add(motionPanoParams, 'removeOuterBlack')
        .name(mt("menu.panorama.removeOuterBlack.label"))
        .tooltip(mt("menu.panorama.removeOuterBlack.tooltip")).perm();

    // --- Feature pano (feature matching + warping) ---
    exportFeaturePanoMenuItem = panoFolder.add(menuActions, 'exportFeaturePano')
        .name(mt("menu.panorama.exportFeature.label"))
        .tooltip(mt("menu.panorama.exportFeature.tooltip"))
        .perm();

    exportFeaturePanoVideoMenuItem = panoFolder.add(menuActions, 'exportFeaturePanoVideo')
        .name(mt("menu.panorama.exportFeatureVideo.label"))
        .tooltip(mt("menu.panorama.exportFeatureVideo.tooltip"))
        .perm();

    const featurePanoParams = {
        get featureFrameStep() { return panoFeatureFrameStep; }, set featureFrameStep(v) { panoFeatureFrameStep = v; },
        get featureCrop() { return panoFeatureCrop; }, set featureCrop(v) { panoFeatureCrop = v; },
        get featureUseMask() { return panoFeatureUseMask; }, set featureUseMask(v) { panoFeatureUseMask = v; },
        get featureProjection() { return panoFeatureProjection; }, set featureProjection(v) { panoFeatureProjection = v; },
    };
    const featureOptions = panoFolder.addFolder(mt("menu.panorama.featureOptions.title")).close().perm();
    featureOptions.add(featurePanoParams, 'featureFrameStep', 1, 60, 1)
        .name(mt("menu.panorama.featureFrameStep.label"))
        .tooltip(mt("menu.panorama.featureFrameStep.tooltip")).perm();
    featureOptions.add(featurePanoParams, 'featureCrop', 0, 100, 1)
        .name(mt("menu.panorama.featureCrop.label"))
        .tooltip(mt("menu.panorama.featureCrop.tooltip")).perm();
    featureOptions.add(featurePanoParams, 'featureUseMask')
        .name(mt("menu.panorama.featureUseMask.label"))
        .tooltip(mt("menu.panorama.featureUseMask.tooltip")).perm();
    featureOptions.add(featurePanoParams, 'featureProjection', {Auto: 'auto', Planar: 'planar', Rigid: 'rigid'})
        .name(mt("menu.panorama.featureProjection.label"))
        .tooltip(mt("menu.panorama.featureProjection.tooltip")).perm();

    // Masking is a persistent folder, available as soon as a video is loaded — it
    // does NOT require Start Analysis. Its controls route through ensureMaskingAnalyzer()
    // so the analyzer + mask overlay are spun up lazily on first use.
    createMaskingFolder(motionFolder);
}

// Build the persistent "Masking" folder. Every control reads through to the
// current analyzer (or a sensible default before one exists) and writes via
// ensureMaskingAnalyzer(), which creates the analyzer + mask overlay on demand.
// Because it lives outside createParamSliders/paramControllers, it survives
// Start/Stop Analysis and is present whenever a video is loaded.
function createMaskingFolder(parentFolder) {
    const maskFolder = parentFolder.addFolder("Masking").close().perm();

    // Live read-through accessors so the controls work before an analyzer exists.
    // Action buttons + the editMask flag + the colour object live as plain props;
    // the numeric/boolean analyzer fields are defined as proxies below.
    const maskParams = {
        editMask: false,
        // Colour is bound as a plain object (lil-gui mutates addColor objects in
        // place) and pushed into the analyzer on change.
        autoMaskTargetColor: {r: 235, g: 235, b: 235},
        clearMask: () => { const a = ensureMaskingAnalyzer(); if (a) { a.clearMask(); a.onMaskChange(); } },
        autoMask: () => { const a = ensureMaskingAnalyzer(); if (a) a.autoMask(); },
        autoMaskRedactions: () => { const a = ensureMaskingAnalyzer(); if (a) a.autoMaskRedactions(); },
    };

    // [property, default, sideEffect(analyzer)] — numeric / boolean fields that
    // live on the analyzer. The setter ensures the analyzer, writes the value,
    // then runs the side effect (re-run auto-mask / redactions / preview).
    const maskFields = [
        ['maskEnabled', true, a => { a.updateMaskPreview(); a.onMaskChange(); }],
        ['autoMaskWindow', 10, a => a.autoMask()],
        ['autoMaskThreshold', 0.9, a => a.autoMask()],
        ['autoMaskSpread', 5, a => a.autoMask()],
        ['autoMaskCloseToTarget', 140, a => a.autoMask()],
        ['redactionWindow', 8, a => a.autoMaskRedactions()],
        ['redactionInvariance', 5, a => a.autoMaskRedactions()],
        ['redactionMaxLuma', 180, a => a.autoMaskRedactions()],
        ['redactionFlatness', 10, a => a.autoMaskRedactions()],
        ['redactionMinSize', 12, a => a.autoMaskRedactions()],
        ['redactionFill', 0.6, a => a.autoMaskRedactions()],
        ['redactionSnap', 6, a => a.autoMaskRedactions()],
        ['redactionSpread', 8, a => a.autoMaskRedactions()],
    ];
    for (const [prop, dflt, after] of maskFields) {
        Object.defineProperty(maskParams, prop, {
            enumerable: true,
            get() { return motionAnalyzer ? motionAnalyzer[prop] : dflt; },
            set(v) { const a = ensureMaskingAnalyzer(); if (!a) return; a[prop] = v; after?.(a); },
        });
    }
    Object.defineProperty(maskParams, 'brushSize', {
        enumerable: true,
        get() { return motionAnalyzer?.maskOverlayNode?.brushSize ?? 20; },
        set(v) { const a = ensureMaskingAnalyzer(); if (a?.maskOverlayNode) { a.maskOverlayNode.brushSize = v; setRenderOne(true); } },
    });

    maskFolder.add(maskParams, 'maskEnabled').name("Enable Mask").perm()
        .tooltip("Enable/disable mask filtering");

    maskFolder.add(maskParams, 'editMask').name("Edit Mask").perm()
        .onChange((v) => { const a = ensureMaskingAnalyzer(); if (a) a.setMaskEditing(v); })
        .tooltip("Click and drag to paint mask (Alt/Option to erase)");

    maskFolder.add(maskParams, 'brushSize', 5, 50, 1).name("Brush Size").perm()
        .tooltip("Mask brush size in pixels");

    maskFolder.add(maskParams, 'clearMask').name("Clear Mask").perm()
        .tooltip("Clear all mask data");

    maskFolder.add(maskParams, 'autoMask').name("Auto Mask").perm()
        .tooltip("Add a mask of static text-coloured pixels over the frame window (adds to the mask; use Clear Mask to reset)");

    maskFolder.add(maskParams, 'autoMaskWindow', 10, 30, 1).name("Auto Window").perm()
        .tooltip("Number of frames to analyze for auto mask");
    maskFolder.add(maskParams, 'autoMaskThreshold', 0.9, 1, 0.001).name("Auto Threshold").perm()
        .tooltip("Color similarity threshold (higher = stricter)");
    maskFolder.add(maskParams, 'autoMaskSpread', 1, 10, 0.1).name("Auto Spread").perm()
        .tooltip("Radius of mask circle at each invariant pixel");
    maskFolder.addColor(maskParams, 'autoMaskTargetColor', 255).name("Target Color").perm()
        .onChange(() => { const a = ensureMaskingAnalyzer(); if (a) { a.autoMaskTargetColor = {...maskParams.autoMaskTargetColor}; a.autoMask(); } })
        .tooltip("Target color for auto mask");
    maskFolder.add(maskParams, 'autoMaskCloseToTarget', 0, 255, 1).name("Color Tolerance").perm()
        .tooltip("How close pixel must be to target color (lower = stricter)");

    maskFolder.add(maskParams, 'autoMaskRedactions').name("Auto Mask Redactions").perm()
        .tooltip("Detect solid black/grey rectangular redaction boxes and add them to the mask (adds to the mask; use Clear Mask to reset)");
    maskFolder.add(maskParams, 'redactionWindow', 2, 30, 1).name("Redaction Frames").perm()
        .tooltip("Number of frames analysed to find invariant (unchanging) regions");
    maskFolder.add(maskParams, 'redactionInvariance', 1, 15, 0.5).name("Redaction Invariance %").perm()
        .tooltip("Max % brightness change for a pixel to count as invariant (lower = stricter)");
    maskFolder.add(maskParams, 'redactionMaxLuma', 0, 255, 1).name("Redaction Max Bright").perm()
        .tooltip("Ignore pixels brighter than this (keeps black..mid-grey redactions)");
    maskFolder.add(maskParams, 'redactionFlatness', 0, 40, 1).name("Redaction Flatness").perm()
        .tooltip("Max local brightness variation for a solid fill (lower = stricter; this is what rejects textured terrain)");
    maskFolder.add(maskParams, 'redactionMinSize', 4, 100, 1).name("Redaction Min Size").perm()
        .tooltip("Minimum box width AND height in pixels");
    maskFolder.add(maskParams, 'redactionFill', 0.3, 1, 0.05).name("Redaction Min Fill").perm()
        .tooltip("Minimum filled fraction of the bounding box (rectangularity)");
    maskFolder.add(maskParams, 'redactionSnap', 0, 30, 1).name("Redaction Snap").perm()
        .tooltip("Bridge slivers up to this many px between adjacent boxes (closes grey↔black transition gaps; 0 = off)");
    maskFolder.add(maskParams, 'redactionSpread', 0, 20, 1).name("Redaction Expand").perm()
        .tooltip("Expand each detected box outward by this many pixels (outer margin)");
}

function createParamSliders() {
    if (!motionFolder || !motionAnalyzer) return;
    
    removeParamSliders();
    
    if (motionAnalyzer.autoMaskWindow === undefined) {
        motionAnalyzer.autoMaskWindow = 10;
    }
    if (motionAnalyzer.autoMaskThreshold === undefined) {
        motionAnalyzer.autoMaskThreshold = 0.9;
    }
    if (motionAnalyzer.autoMaskSpread === undefined) {
        motionAnalyzer.autoMaskSpread = 5;
    }
    if (!motionAnalyzer.autoMaskTargetColor || typeof motionAnalyzer.autoMaskTargetColor !== 'object') {
        motionAnalyzer.autoMaskTargetColor = {r: 235, g: 235, b: 235};
    }
    if (motionAnalyzer.autoMaskCloseToTarget === undefined) {
        motionAnalyzer.autoMaskCloseToTarget = 140;
    }
    if (motionAnalyzer.redactionWindow === undefined) {
        motionAnalyzer.redactionWindow = 8;
    }
    if (motionAnalyzer.redactionInvariance === undefined) {
        motionAnalyzer.redactionInvariance = 5;
    }
    if (motionAnalyzer.redactionMaxLuma === undefined) {
        motionAnalyzer.redactionMaxLuma = 180;
    }
    if (motionAnalyzer.redactionFlatness === undefined) {
        motionAnalyzer.redactionFlatness = 10;
    }
    if (motionAnalyzer.redactionMinSize === undefined) {
        motionAnalyzer.redactionMinSize = 12;
    }
    if (motionAnalyzer.redactionFill === undefined) {
        motionAnalyzer.redactionFill = 0.6;
    }
    if (motionAnalyzer.redactionSnap === undefined) {
        motionAnalyzer.redactionSnap = 6;
    }
    if (motionAnalyzer.redactionSpread === undefined) {
        motionAnalyzer.redactionSpread = 8;
    }
    if (!Array.isArray(motionAnalyzer.redactionRects)) {
        motionAnalyzer.redactionRects = [];
    }

    const p = motionAnalyzer.params;
    const invalidate = () => motionAnalyzer.onParamChange();

    const trackingFolder = motionFolder.addFolder(mt("menu.trackingParameters.title")).close();
    paramControllers.push(trackingFolder);
    
    if (isAdmin()) {
        const techniqueOptions = Object.values(MOTION_TECHNIQUES);
        paramControllers.push(trackingFolder.add(p, 'technique', techniqueOptions).name(mt("menu.trackingParameters.technique.label")).onChange((newTechnique) => {
            console.log("Technique changed to:", newTechnique);
            invalidate();
            removeParamSliders();
            createParamSliders();
        }).tooltip(mt("menu.trackingParameters.technique.tooltip")));
    }
    
    const isTracklet = p.technique === MOTION_TECHNIQUES.LINEAR_TRACKLET;
    paramControllers.push(trackingFolder.add(p, 'frameSkip', 1, 10, 1)
        .name(isTracklet ? mt("menu.trackingParameters.trackletLength.label") : mt("menu.trackingParameters.frameSkip.label"))
        .onChange(invalidate)
        .tooltip(isTracklet ? mt("menu.trackingParameters.trackletLength.tooltip") : mt("menu.trackingParameters.frameSkip.tooltip")));
    paramControllers.push(trackingFolder.add(p, 'skipDuplicateFrames')
        .name(mt("menu.trackingParameters.skipDuplicateFrames.label"))
        .onChange(invalidate)
        .tooltip(mt("menu.trackingParameters.skipDuplicateFrames.tooltip")));
    paramControllers.push(trackingFolder.add(p, 'blurSize', 1, 15, 2).name(mt("menu.trackingParameters.blurSize.label")).onChange(invalidate)
        .tooltip(mt("menu.trackingParameters.blurSize.tooltip")));
    paramControllers.push(trackingFolder.add(p, 'minMotion', 0, 2, 0.1).name(mt("menu.trackingParameters.minMotion.label")).onChange(invalidate)
        .tooltip(mt("menu.trackingParameters.minMotion.tooltip")));
    paramControllers.push(trackingFolder.add(p, 'maxMotion', 10, 200, 5).name(mt("menu.trackingParameters.maxMotion.label")).onChange(invalidate)
        .tooltip(mt("menu.trackingParameters.maxMotion.tooltip")));
    paramControllers.push(trackingFolder.add(p, 'smoothingAlpha', 0.5, 0.99, 0.01).name(mt("menu.trackingParameters.smoothing.label")).onChange(invalidate)
        .tooltip(mt("menu.trackingParameters.smoothing.tooltip")));
    paramControllers.push(trackingFolder.add(p, 'minVectorCount', 1, 50, 1).name(mt("menu.trackingParameters.minVectorCount.label")).onChange(invalidate)
        .tooltip(mt("menu.trackingParameters.minVectorCount.tooltip")));
    paramControllers.push(trackingFolder.add(p, 'minConsensusConfidence', 0, 0.5, 0.01).name(mt("menu.trackingParameters.minConfidence.label")).onChange(invalidate)
        .tooltip(mt("menu.trackingParameters.minConfidence.tooltip")));
    
    const usesFeatures = p.technique === MOTION_TECHNIQUES.SPARSE_CONSENSUS || p.technique === MOTION_TECHNIQUES.AFFINE_RANSAC || p.technique === MOTION_TECHNIQUES.LINEAR_TRACKLET;
    if (usesFeatures) {
        paramControllers.push(trackingFolder.add(p, 'maxFeatures', 50, 500, 10).name(mt("menu.trackingParameters.maxFeatures.label")).onChange(invalidate)
            .tooltip(mt("menu.trackingParameters.maxFeatures.tooltip")));
        paramControllers.push(trackingFolder.add(p, 'minDistance', 5, 50, 1).name(mt("menu.trackingParameters.minDistance.label")).onChange(invalidate)
            .tooltip(mt("menu.trackingParameters.minDistance.tooltip")));
        paramControllers.push(trackingFolder.add(p, 'qualityLevel', 0.001, 0.1, 0.001).name(mt("menu.trackingParameters.qualityLevel.label")).onChange(invalidate)
            .tooltip(mt("menu.trackingParameters.qualityLevel.tooltip")));
        paramControllers.push(trackingFolder.add(p, 'maxTrackError', 5, 50, 1).name(mt("menu.trackingParameters.maxTrackError.label")).onChange(invalidate)
            .tooltip(mt("menu.trackingParameters.maxTrackError.tooltip")));
    }
    
    if (p.technique === MOTION_TECHNIQUES.SPARSE_CONSENSUS) {
        paramControllers.push(trackingFolder.add(p, 'minQuality', 0, 1, 0.05).name(mt("menu.trackingParameters.minQuality.label")).onChange(invalidate)
            .tooltip(mt("menu.trackingParameters.minQuality.tooltip")));
        paramControllers.push(trackingFolder.add(p, 'staticThreshold', 0.1, 2, 0.1).name(mt("menu.trackingParameters.staticThreshold.label")).onChange(invalidate)
            .tooltip(mt("menu.trackingParameters.staticThreshold.tooltip")));
        paramControllers.push(trackingFolder.add(p, 'staticFrames', 5, 30, 1).name("Static Frames").onChange(invalidate)
            .tooltip("Frames to confirm static detection"));
        paramControllers.push(trackingFolder.add(p, 'inlierThreshold', 0.3, 0.9, 0.05).name("Inlier Threshold").onChange(invalidate)
            .tooltip("Threshold for consensus direction agreement"));
    }
    
    if (p.technique === MOTION_TECHNIQUES.ECC_EUCLIDEAN) {
        paramControllers.push(trackingFolder.add(p, 'eccIterations', 10, 200, 10).name("ECC Iterations").onChange(invalidate)
            .tooltip("Maximum iterations for ECC convergence"));
        paramControllers.push(trackingFolder.add(p, 'eccEpsilon', 0.0001, 0.01, 0.0001).name("ECC Epsilon").onChange(invalidate)
            .tooltip("Convergence threshold for ECC"));
    }
    
    if (p.technique === MOTION_TECHNIQUES.AFFINE_RANSAC) {
        paramControllers.push(trackingFolder.add(p, 'ransacThreshold', 1, 10, 0.5).name("RANSAC Threshold").onChange(invalidate)
            .tooltip("Maximum reprojection error for inliers (pixels)"));
    }
    
    if (p.technique === MOTION_TECHNIQUES.LINEAR_TRACKLET) {
        paramControllers.push(trackingFolder.add(p, 'minQuality', 0, 1, 0.05).name("Min Quality").onChange(invalidate)
            .tooltip("Minimum quality to display arrow"));
        paramControllers.push(trackingFolder.add(p, 'staticThreshold', 0.1, 2, 0.1).name("Static Threshold").onChange(invalidate)
            .tooltip("Motion below this is considered static (HUD)"));
        paramControllers.push(trackingFolder.add(p, 'staticFrames', 5, 30, 1).name("Static Frames").onChange(invalidate)
            .tooltip("Frames to confirm static detection"));
        paramControllers.push(trackingFolder.add(p, 'inlierThreshold', 0.3, 0.9, 0.05).name("Inlier Threshold").onChange(invalidate)
            .tooltip("Threshold for consensus direction agreement"));
        paramControllers.push(trackingFolder.add(p, 'linearityThreshold', 0.5, 1, 0.05).name("Linearity Threshold").onChange(invalidate)
            .tooltip("Min trajectory straightness (1=perfect line)"));
        paramControllers.push(trackingFolder.add(p, 'spacingThreshold', 0, 1, 0.05).name("Spacing Threshold").onChange(invalidate)
            .tooltip("Min step spacing consistency (1=perfectly even)"));
    }
    
    let optimizeBtn = null;
    let enoughBtn = null;
    let abortBtn = null;
    let statusText = {value: "Ready"};
    let statusCtrl = null;
    
    const showOptimizeButtons = (show) => {
        if (optimizeBtn) optimizeBtn.show(!show);
        if (enoughBtn) enoughBtn.show(show);
        if (abortBtn) abortBtn.show(show);
    };
    
    setUpdateGuiValues(() => {
        for (const ctrl of paramControllers) {
            if (ctrl && ctrl.updateDisplay) {
                try { ctrl.updateDisplay(); } catch (e) {}
            }
        }
    });

    setUpdateOptimizeStatus((gen, fitness, bestParams) => {
        if (bestParams) {
            statusText.value = `Gen ${gen}: fit=${fitness.toFixed(3)} [fs=${bestParams.frameSkip} blur=${bestParams.blurSize} feat=${bestParams.maxFeatures} qual=${bestParams.minQuality.toFixed(2)}]`;
        } else {
            statusText.value = `Gen ${gen}: fit=${fitness.toFixed(3)}`;
        }
        if (statusCtrl) statusCtrl.updateDisplay();
    });
    
    const buildReport = (original, final, accepted) => {
        const changes = [];
        if (original.frameSkip !== final.frameSkip) {
            changes.push(`Tracklet Length: ${original.frameSkip} → ${final.frameSkip}`);
        }
        if (original.blurSize !== final.blurSize) {
            changes.push(`Blur Size: ${original.blurSize} → ${final.blurSize}`);
        }
        if (original.maxFeatures !== final.maxFeatures) {
            changes.push(`Max Features: ${original.maxFeatures} → ${final.maxFeatures}`);
        }
        if (original.minQuality !== final.minQuality) {
            changes.push(`Min Quality: ${original.minQuality.toFixed(2)} → ${final.minQuality.toFixed(2)}`);
        }
        if (changes.length === 0) {
            return accepted ? "No changes (already optimal)" : "Aborted - no changes";
        }
        return (accepted ? "Changed:\n" : "Restored:\n") + changes.join("\n");
    };
    
    const runOptimization = async () => {
        if (!motionAnalyzer) return;
        motionAnalyzer.startOptimization();
        const originalParams = {...motionAnalyzer.optimizeParamsBeforeStart};
        showOptimizeButtons(true);
        statusText.value = "Optimizing...";
        if (statusCtrl) statusCtrl.updateDisplay();
        
        while (motionAnalyzer.optimizing && !motionAnalyzer.optimizeAborted) {
            const continueOpt = await motionAnalyzer.runOptimizationStep();
            if (!continueOpt) break;
        }
        
        let reportText = "";
        if (!motionAnalyzer.optimizeAborted && motionAnalyzer.optimizeBestParams) {
            motionAnalyzer.acceptOptimization();
            reportText = buildReport(originalParams, motionAnalyzer.params, true);
            statusText.value = reportText;
            console.log("Optimization complete:\n" + reportText);
        } else if (motionAnalyzer.optimizeAborted) {
            reportText = buildReport(originalParams, motionAnalyzer.params, false);
            statusText.value = reportText;
        }
        
        showOptimizeButtons(false);
        if (statusCtrl) statusCtrl.updateDisplay();
        updateGuiValues();
        removeParamSliders();
        createParamSliders();
        setRenderOne(true);
    };
    
    const enoughOptimization = () => {
        if (motionAnalyzer) {
            const originalParams = {...motionAnalyzer.optimizeParamsBeforeStart};
            motionAnalyzer.acceptOptimization();
            const reportText = buildReport(originalParams, motionAnalyzer.params, true);
            statusText.value = reportText;
            console.log("Optimization accepted:\n" + reportText);
        }
        showOptimizeButtons(false);
        if (statusCtrl) statusCtrl.updateDisplay();
        updateGuiValues();
        removeParamSliders();
        createParamSliders();
        setRenderOne(true);
    };
    
    const abortOptimization = () => {
        if (motionAnalyzer) {
            const originalParams = {...motionAnalyzer.optimizeParamsBeforeStart};
            motionAnalyzer.abortOptimization();
            const reportText = buildReport(motionAnalyzer.optimizeBestParams || originalParams, originalParams, false);
            statusText.value = reportText;
        }
        showOptimizeButtons(false);
        if (statusCtrl) statusCtrl.updateDisplay();
        updateGuiValues();
        removeParamSliders();
        createParamSliders();
        setRenderOne(true);
    };
    
    const optimizeControls = {
        optimize: runOptimization,
        enough: enoughOptimization,
        abort: abortOptimization,
    };
    
    optimizeBtn = trackingFolder.add(optimizeControls, 'optimize').name("Optimize")
        .tooltip("Run genetic algorithm to find optimal params for current frame");
    paramControllers.push(optimizeBtn);
    
    enoughBtn = trackingFolder.add(optimizeControls, 'enough').name("Enough (Accept)")
        .tooltip("Accept current best parameters and stop optimization");
    paramControllers.push(enoughBtn);
    enoughBtn.show(false);
    
    abortBtn = trackingFolder.add(optimizeControls, 'abort').name("Abort (Reset)")
        .tooltip("Cancel optimization and restore original parameters");
    paramControllers.push(abortBtn);
    abortBtn.show(false);
    
    statusCtrl = trackingFolder.add(statusText, 'value').name("Status").listen().disable();
    paramControllers.push(statusCtrl);

    // The Masking folder is NOT built here — it is a persistent folder created
    // once in addMotionAnalysisMenu() (via createMaskingFolder) so it is available
    // whenever a video is loaded, not only while analysis is running.

    paramControllers.push(motionFolder.add(motionAnalyzer, 'speedOverlayEnabled').name("Speed Overlay").onChange((v) => {
        motionAnalyzer.setSpeedOverlayEnabled(v);
    }).tooltip("Show thermal heat map of optical flow speed"));
    
    motionFolder.open();
}

function removeParamSliders() {
    for (const ctrl of paramControllers) {
        try { ctrl.destroy(); } catch (e) {}
    }
    paramControllers = [];
}

export function getMotionAnalysisOverlays() {
    if (!motionAnalyzer || !motionAnalyzer.active) return null;
    return {
        overlay: motionAnalyzer.overlay,
        graphCanvas: motionAnalyzer.graphCanvas,
        videoView: motionAnalyzer.videoView,
    };
}

export function getMotionAnalyzerForTesting() {
    return motionAnalyzer;
}

export function serializeMotionAnalysis() {
    if (!motionAnalyzer) return null;
    
    return {
        active: motionAnalyzer.active,
        params: {...motionAnalyzer.params},
        maskEnabled: motionAnalyzer.maskEnabled,
        brushSize: motionAnalyzer.brushSize,
        autoMaskWindow: motionAnalyzer.autoMaskWindow,
        autoMaskThreshold: motionAnalyzer.autoMaskThreshold,
        autoMaskSpread: motionAnalyzer.autoMaskSpread,
        autoMaskTargetColor: {...motionAnalyzer.autoMaskTargetColor},
        autoMaskCloseToTarget: motionAnalyzer.autoMaskCloseToTarget,
        redactionWindow: motionAnalyzer.redactionWindow,
        redactionInvariance: motionAnalyzer.redactionInvariance,
        redactionMaxLuma: motionAnalyzer.redactionMaxLuma,
        redactionFlatness: motionAnalyzer.redactionFlatness,
        redactionMinSize: motionAnalyzer.redactionMinSize,
        redactionFill: motionAnalyzer.redactionFill,
        redactionSnap: motionAnalyzer.redactionSnap,
        redactionSpread: motionAnalyzer.redactionSpread,
        maskData: motionAnalyzer.maskOverlayNode?.maskData ?? null,
    };
}

export async function deserializeMotionAnalysis(data) {
    if (!data) return;
    
    const videoView = NodeMan.get("video", false);
    if (!videoView) return;
    
    if (data.active) {
        const doRestore = () => {
            if (!motionAnalyzer) {
                motionAnalyzer = new MotionAnalyzer(videoView);
            }
            setMotionAnalyzerRef(motionAnalyzer);
            
            if (data.params) {
                Object.assign(motionAnalyzer.params, data.params);
                if (data.params.skipDuplicateFrames === undefined) {
                    motionAnalyzer.params.skipDuplicateFrames = true;
                }
            }
            if (data.maskEnabled !== undefined) {
                motionAnalyzer.maskEnabled = data.maskEnabled;
            }
            if (data.brushSize !== undefined) {
                motionAnalyzer.brushSize = data.brushSize;
            }
            if (data.autoMaskWindow !== undefined) {
                motionAnalyzer.autoMaskWindow = data.autoMaskWindow;
            }
            if (data.autoMaskThreshold !== undefined) {
                motionAnalyzer.autoMaskThreshold = data.autoMaskThreshold;
            }
            if (data.autoMaskSpread !== undefined) {
                motionAnalyzer.autoMaskSpread = data.autoMaskSpread;
            }
            if (data.autoMaskTargetColor !== undefined) {
                motionAnalyzer.autoMaskTargetColor = {...data.autoMaskTargetColor};
            }
            if (data.autoMaskCloseToTarget !== undefined) {
                motionAnalyzer.autoMaskCloseToTarget = data.autoMaskCloseToTarget;
            }
            if (data.redactionWindow !== undefined) {
                motionAnalyzer.redactionWindow = data.redactionWindow;
            }
            if (data.redactionInvariance !== undefined) {
                motionAnalyzer.redactionInvariance = data.redactionInvariance;
            }
            if (data.redactionMaxLuma !== undefined) {
                motionAnalyzer.redactionMaxLuma = data.redactionMaxLuma;
            }
            if (data.redactionFlatness !== undefined) {
                motionAnalyzer.redactionFlatness = data.redactionFlatness;
            }
            if (data.redactionMinSize !== undefined) {
                motionAnalyzer.redactionMinSize = data.redactionMinSize;
            }
            if (data.redactionFill !== undefined) {
                motionAnalyzer.redactionFill = data.redactionFill;
            }
            if (data.redactionSnap !== undefined) {
                motionAnalyzer.redactionSnap = data.redactionSnap;
            }
            if (data.redactionSpread !== undefined) {
                motionAnalyzer.redactionSpread = data.redactionSpread;
            }

            motionAnalyzer.start();
            
            if (data.maskData && motionAnalyzer.maskOverlayNode) {
                motionAnalyzer.maskOverlayNode.maskData = data.maskData;
                motionAnalyzer.maskOverlayNode.loadMask();
            }
            
            if (analyzeMenuItem) {
                analyzeMenuItem.name("Stop Analysis");
            }
            
            createParamSliders();
            
            if (!renderHooked) {
                renderHooked = true;
                const originalRender = videoView.renderCanvas.bind(videoView);
                videoView.renderCanvas = function(frame) {
                    originalRender(frame);
                    if (motionAnalyzer && motionAnalyzer.active) {
                        motionAnalyzer.analyze(frame);
                    }
                };
            }
            
            setRenderOne(true);
        };
        
        // Register as load-blocking async work so the scene is not considered
        // "settled" (and the regression harness does not screenshot) until the
        // saved motion analysis has been re-applied — loadOpenCV() is slow under
        // concurrent load and was previously invisible to the settle resolver, so
        // the overlay could be captured half-restored.
        const _restoreToken = registerPendingWork("motion-analysis-restore");
        try {
            await loadOpenCV();
            setCv(getCV());
            doRestore();
        } finally {
            completePendingWork(_restoreToken);
        }
    }
}
