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

import {GlobalDateTimeNode, Globals, guiMenus, NodeMan, registerFrameBlocker, setRenderOne, Sit, unregisterFrameBlocker} from "./Globals";
import {isAdmin} from "./configUtils";
import {par} from "./par";
import {ExportProgressWidget, getExportPrefix} from "./utils";
import {Color} from "three";
import {getCV, loadOpenCV} from "./openCVLoader";
import {applyConvolution} from "./nodes/CNodeVideoView";
import {getFlowAlignRotation, isAlignWithFlowEnabled, setAlignWithFlow, setMotionAnalyzerRef} from "./FlowAlignment";
import {t} from "./i18n";
import {setStartAnalysis, setUpdateGuiValues, setUpdateOptimizeStatus, updateGuiValues} from "./CMotionAnalysisShared";
import {CNodeMaskOverlay} from "./nodes/CNodeMaskOverlay";
import {CNodeSpeedOverlay} from "./nodes/CNodeSpeedOverlay";
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
const MAX_PANORAMA_WIDTH = 20000;
const PANO_VIDEO_4K_WIDTH = 3840;
const PANO_VIDEO_4K_HEIGHT = 2160;

// Panorama export toggles — the addMotionAnalysisMenu folder below wires them.
let exportWithEffects = false;
let removeOuterBlack = false;
let panoCrop = 0;
let useMaskInPano = true;
let panoFrameStep = 1;

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
    const croppedWidth = frameWidth - 2 * crop;
    const croppedHeight = frameHeight - 2 * crop;

    const pxRange = maxPx - minPx;
    const pyRange = maxPy - minPy;

    let panoWidthPx = Math.ceil(pxRange + croppedWidth);
    let panoHeightPx = Math.ceil(pyRange + croppedHeight);

    let scale = 1;
    if (panoWidthPx > MAX_PANORAMA_WIDTH) {
        scale = MAX_PANORAMA_WIDTH / panoWidthPx;
        panoWidthPx = MAX_PANORAMA_WIDTH;
        panoHeightPx = Math.ceil(panoHeightPx * scale);
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

function drawFrameToPano(panoCtx, image, x, y, crop, croppedWidth, croppedHeight, scaledFrameWidth, scaledFrameHeight, useMask, tempCanvas, tempCtx, maskImageData, frameWidth, frameHeight, rotation = 0) {
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
        if (rotation !== 0) {
            panoCtx.save();
            panoCtx.translate(dx + dw / 2, dy + dh / 2);
            panoCtx.rotate(rotation);
            panoCtx.drawImage(src, sx, sy, sw, sh, -dw / 2, -dh / 2, dw, dh);
            panoCtx.restore();
        } else {
            panoCtx.drawImage(src, sx, sy, sw, sh, dx, dy, dw, dh);
        }
    };
    
    if (useMask && maskImageData) {
        tempCtx.clearRect(0, 0, frameWidth, frameHeight);
        tempCtx.drawImage(sourceImage, 0, 0);
        const frameImgData = tempCtx.getImageData(crop, crop, croppedWidth, croppedHeight);
        const framePixels = frameImgData.data;
        const maskPixels = maskImageData.data;
        const maskWidth = maskImageData.width;
        
        for (let py = 0; py < croppedHeight; py++) {
            for (let px = 0; px < croppedWidth; px++) {
                const maskX = px + crop;
                const maskY = py + crop;
                if (maskX < maskWidth && maskY < maskImageData.height) {
                    const maskIdx = (maskY * maskWidth + maskX) * 4;
                    if (maskPixels[maskIdx + 3] > 128) {
                        const frameIdx = (py * croppedWidth + px) * 4;
                        framePixels[frameIdx + 3] = 0;
                    }
                }
            }
        }
        
        tempCtx.putImageData(frameImgData, crop, crop);
        drawWithRotation(tempCanvas, crop, crop, croppedWidth, croppedHeight, x, y, scaledFrameWidth, scaledFrameHeight);
    } else {
        drawWithRotation(sourceImage, crop, crop, croppedWidth, croppedHeight, x, y, scaledFrameWidth, scaledFrameHeight);
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

let motionFolder = null;
let motionTrackCounter = 0;
let createTrackMenuItem = null;
let exportMotionMenuItem = null;

// Lock so concurrent callers (e.g. both pano export menu items clicked in
// quick succession) coalesce onto a single analysis pass and just report
// progress, instead of each running their own polling loop and racing the
// par.frame / Globals.justVideoAnalysis state.
let analysisInProgress = null;

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
            });

            // Re-run the selected range against the fixed virtual frame list,
            // but keep the duplicate map itself.
            resetMotionAnalysisDerivedState(false);
            motionAnalyzer.suspendAnalysis = false;
            resetVideoThrashDetector(videoData);
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
            let stillMissing = 0;
            for (let f = aFrame; f <= bFrame; f++) {
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
        });
        progressCallback?.({
            phase: "fallback",
            step: 3,
            steps: 3,
            current: 1,
            total: 1,
            pct: 100,
        });

        return isMotionAnalysisReady();
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

// MAX_PANORAMA_WIDTH, PANO_VIDEO_4K_*, exportWithEffects, removeOuterBlack,
// panoCrop, useMaskInPano and panoFrameStep are declared at the top of this
// file (the helpers extracted from calculatePanoDimensions / drawFrameToPano
// use them before this block).
let exportPanoMenuItem = null;
let exportPanoVideoMenuItem = null;
let stabilizeMenuItem = null;
let stabilizationEnabled = false;

async function exportMotionPanorama() {
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
    });
    const motionData = motionAnalyzer.getMotionDataForAllFrames({gapFill: false, fallbackToSmoothed: false, useTrackletLastSegment: true});

    const panoRotation = isAlignWithFlowEnabled() ? -calculateOverallMotionAngle(motionData, startFrame, endFrame) : 0;
    const {frameData, totalFrames, minPx, maxPx, minPy, maxPy} = calculateFrameOffsets(motionData, startFrame, endFrame, panoFrameStep, panoRotation);
    const {frameWidth, frameHeight, croppedWidth, croppedHeight, panoWidthPx, panoHeightPx, scale, scaledFrameWidth, scaledFrameHeight} = calculatePanoDimensions(videoData, startFrame, minPx, maxPx, minPy, maxPy, crop);

    if (isAlignWithFlowEnabled()) {
        console.log(`Motion Panorama: Aligned with flow, rotation=${(panoRotation * 180 / Math.PI).toFixed(1)}°`);
    }
    console.log(`Motion Panorama: X range ${minPx.toFixed(1)} to ${maxPx.toFixed(1)} px (${(maxPx-minPx).toFixed(1)}px)`);
    console.log(`Motion Panorama: Y range ${minPy.toFixed(1)} to ${maxPy.toFixed(1)} px (${(maxPy-minPy).toFixed(1)}px)`);
    console.log(`Motion Panorama: ${panoWidthPx}x${panoHeightPx}px, scale=${scale.toFixed(3)}`);

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
    
    if (useMask) {
        tempCanvas = document.createElement('canvas');
        tempCanvas.width = frameWidth;
        tempCanvas.height = frameHeight;
        tempCtx = tempCanvas.getContext('2d', {willReadFrequently: true});
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
    for (let i = 0; i < totalFrames; i++) {
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

        const x = (fd.px - minPx) * scale;
        const y = (fd.py - minPy) * scale;

        drawFrameToPano(panoCtx, image, x, y, crop, croppedWidth, croppedHeight, scaledFrameWidth, scaledFrameHeight, useMask, tempCanvas, tempCtx, maskImageData, frameWidth, frameHeight, panoRotation);

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

    updatePreview();
    statusText.textContent = mt("status.saving");
    Globals.justVideoAnalysis = false;
    par.paused = savedPaused;
    par.frame = savedFrame;
    
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

async function exportPanoVideo() {
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
    });
    const motionData = motionAnalyzer.getMotionDataForAllFrames({gapFill: false, fallbackToSmoothed: false, useTrackletLastSegment: true});

    const panoRotation = isAlignWithFlowEnabled() ? -calculateOverallMotionAngle(motionData, startFrame, endFrame) : 0;
    const {frameData, totalFrames, minPx, maxPx, minPy, maxPy} = calculateFrameOffsets(motionData, startFrame, endFrame, 1, panoRotation);
    const {frameWidth, frameHeight, croppedWidth, croppedHeight, panoWidthPx, panoHeightPx, scale: panoScale, scaledFrameWidth, scaledFrameHeight} = calculatePanoDimensions(videoData, startFrame, minPx, maxPx, minPy, maxPy, crop);

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
    
    if (useMask) {
        tempCanvas = document.createElement('canvas');
        tempCanvas.width = frameWidth;
        tempCanvas.height = frameHeight;
        tempCtx = tempCanvas.getContext('2d', {willReadFrequently: true});
        motionAnalyzer.maskOverlayNode.updateMaskImageData();
        maskImageData = motionAnalyzer.maskOverlayNode.maskImageData;
    }

    Globals.justVideoAnalysis = true;
    const savedPaused = par.paused;
    const savedFrame = par.frame;
    par.paused = true;
    
    for (let i = 0; i < totalFrames; i++) {
        const fd = frameData[i];
        
        par.frame = fd.frame;
        GlobalDateTimeNode.update(fd.frame);

        videoData.getImage(fd.frame);
        const loaded = await videoData.waitForFrame(fd.frame, 5000);
        if (!loaded) continue;
        
        const image = videoData.getImageNoPurge(fd.frame);
        if (!image || !image.width) continue;

        const x = (fd.px - minPx) * panoScale;
        const y = (fd.py - minPy) * panoScale;

        drawFrameToPano(panoCtx, image, x, y, crop, croppedWidth, croppedHeight, scaledFrameWidth, scaledFrameHeight, useMask, tempCanvas, tempCtx, maskImageData, frameWidth, frameHeight, panoRotation);

        if (i % 20 === 0) {
            const pct = Math.round(100 * i / totalFrames);
            setMenuItemLabel(exportPanoVideoMenuItem, "status.panoPercent", {pct});
            await new Promise(r => setTimeout(r, 0));
        }
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
            if (progress.shouldStop()) break;

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

            const frameX = offsetX + (fd.px - minPx) * panoScale * videoFrameScaleX;
            const frameY = offsetY + (fd.py - minPy) * panoScale * videoFrameScaleY;

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

            if (panoRotation !== 0) {
                compositeCtx.save();
                compositeCtx.translate(frameX + videoFrameWidth / 2, frameY + videoFrameHeight / 2);
                compositeCtx.rotate(panoRotation);
                compositeCtx.drawImage(
                    overlayImage,
                    crop, crop, croppedWidth, croppedHeight,
                    -videoFrameWidth / 2, -videoFrameHeight / 2, videoFrameWidth, videoFrameHeight
                );
                compositeCtx.restore();
            } else {
                compositeCtx.drawImage(
                    overlayImage,
                    crop, crop, croppedWidth, croppedHeight,
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

        if (progress.shouldSave()) {
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

    const panoFolder = motionFolder.addFolder(mt("menu.panorama.title")).close().perm();
    
    exportPanoMenuItem = panoFolder.add(menuActions, 'exportPanorama')
        .name(mt("menu.panorama.exportImage.label"))
        .tooltip(mt("menu.panorama.exportImage.tooltip"))
        .perm();

    exportPanoVideoMenuItem = panoFolder.add(menuActions, 'exportPanoVideo')
        .name(mt("menu.panorama.exportVideo.label"))
        .tooltip(mt("menu.panorama.exportVideo.tooltip"))
        .perm();

    stabilizeMenuItem = panoFolder.add(menuActions, 'stabilizeVideo')
        .name(mt("menu.panorama.stabilize.label"))
        .tooltip(mt("menu.panorama.stabilize.tooltip"))
        .perm();

    const panoParams = {
        get panoCrop() { return panoCrop; }, set panoCrop(v) { panoCrop = v; },
        get useMaskInPano() { return useMaskInPano; }, set useMaskInPano(v) { useMaskInPano = v; },
        get panoFrameStep() { return panoFrameStep; }, set panoFrameStep(v) { panoFrameStep = v; },
        // analyzeWithEffects lives in CMotionAnalysis.js (read by imageToGrayscale
        // which remains there with the class). Bridge via the exported setter.
        get analyzeWithEffects() { return getAnalyzeWithEffects(); }, set analyzeWithEffects(v) { setAnalyzeWithEffects(v); },
        get exportWithEffects() { return exportWithEffects; }, set exportWithEffects(v) { exportWithEffects = v; },
        get removeOuterBlack() { return removeOuterBlack; }, set removeOuterBlack(v) { removeOuterBlack = v; }
    };
    panoFolder.add(panoParams, 'panoFrameStep', 1, 60, 1)
        .name(mt("menu.panorama.panoFrameStep.label"))
        .tooltip(mt("menu.panorama.panoFrameStep.tooltip"))
        .perm();
    panoFolder.add(panoParams, 'panoCrop', 0, 100, 1)
        .name(mt("menu.panorama.crop.label"))
        .tooltip(mt("menu.panorama.crop.tooltip"))
        .perm();
    panoFolder.add(panoParams, 'useMaskInPano')
        .name(mt("menu.panorama.useMask.label"))
        .tooltip(mt("menu.panorama.useMask.tooltip"))
        .perm();
    panoFolder.add(panoParams, 'analyzeWithEffects')
        .name(mt("menu.panorama.analyzeWithEffects.label"))
        .tooltip(mt("menu.panorama.analyzeWithEffects.tooltip"))
        .perm();
    panoFolder.add(panoParams, 'exportWithEffects')
        .name(mt("menu.panorama.exportWithEffects.label"))
        .tooltip(mt("menu.panorama.exportWithEffects.tooltip"))
        .perm();
    panoFolder.add(panoParams, 'removeOuterBlack')
        .name(mt("menu.panorama.removeOuterBlack.label"))
        .tooltip(mt("menu.panorama.removeOuterBlack.tooltip"))
        .perm();
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
    
    const p = motionAnalyzer.params;
    const invalidate = () => motionAnalyzer.onParamChange();
    const update = () => setRenderOne(true);
    
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
    
    const maskFolder = motionFolder.addFolder("Masking").close();
    paramControllers.push(maskFolder);
    
    const maskControls = {
        editMask: false,
        clearMask: () => {
            if (motionAnalyzer) {
                motionAnalyzer.clearMask();
                motionAnalyzer.onMaskChange();
            }
        },
        autoMask: () => {
            if (motionAnalyzer) {
                motionAnalyzer.autoMask();
            }
        }
    };
    
    paramControllers.push(maskFolder.add(motionAnalyzer, 'maskEnabled').name("Enable Mask").onChange(() => {
        motionAnalyzer.updateMaskPreview();
        motionAnalyzer.onMaskChange();
    }).tooltip("Enable/disable mask filtering"));
    
    paramControllers.push(maskFolder.add(maskControls, 'editMask').name("Edit Mask").onChange((v) => {
        motionAnalyzer.setMaskEditing(v);
    }).tooltip("Click and drag to paint mask (Alt/Option to erase)"));
    
    if (motionAnalyzer.maskOverlayNode) {
        paramControllers.push(maskFolder.add(motionAnalyzer.maskOverlayNode, 'brushSize', 5, 50, 1).name("Brush Size").onChange(update)
            .tooltip("Mask brush size in pixels"));
    }
    
    paramControllers.push(maskFolder.add(maskControls, 'clearMask').name("Clear Mask")
        .tooltip("Clear all mask data"));
    
    paramControllers.push(maskFolder.add(maskControls, 'autoMask').name("Auto Mask")
        .tooltip("Auto-generate mask from static pixels over frame window"));
    
    const runAutoMask = () => motionAnalyzer.autoMask();
    
    paramControllers.push(maskFolder.add(motionAnalyzer, 'autoMaskWindow', 10, 30, 1).name("Auto Window")
        .onChange(runAutoMask).tooltip("Number of frames to analyze for auto mask"));
    
    paramControllers.push(maskFolder.add(motionAnalyzer, 'autoMaskThreshold', 0.9, 1, 0.001).name("Auto Threshold")
        .onChange(runAutoMask).tooltip("Color similarity threshold (higher = stricter)"));
    
    paramControllers.push(maskFolder.add(motionAnalyzer, 'autoMaskSpread', 1, 10, 0.1).name("Auto Spread")
        .onChange(runAutoMask).tooltip("Radius of mask circle at each invariant pixel"));
    
    paramControllers.push(maskFolder.addColor(motionAnalyzer, 'autoMaskTargetColor', 255).name("Target Color")
        .onChange(runAutoMask).tooltip("Target color for auto mask"));
    
    paramControllers.push(maskFolder.add(motionAnalyzer, 'autoMaskCloseToTarget', 0, 255, 1).name("Color Tolerance")
        .onChange(runAutoMask).tooltip("How close pixel must be to target color (lower = stricter)"));
    
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
        
        await loadOpenCV();
        setCv(getCV());
        doRestore();
    }
}
