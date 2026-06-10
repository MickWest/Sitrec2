import {Globals, NodeMan, registerFrameBlocker, setRenderOne, Sit, unregisterFrameBlocker} from "./Globals";
import {par} from "./par";
import {startAnalysis, updateGuiValues, updateOptimizeStatus} from "./CMotionAnalysisShared";

import {CNodeMaskOverlay} from "./nodes/CNodeMaskOverlay";
import {CNodeSpeedOverlay} from "./nodes/CNodeSpeedOverlay";
import {getCV, loadOpenCV} from "./openCVLoader";
import {applyConvolution} from "./nodes/CNodeVideoView";
import {getFlowAlignRotation} from "./FlowAlignment";
import {detectRedactionRects} from "./RedactionDetect";
import {t} from "./i18n";

let cv = null;
let analyzeWithEffects = false;

// Setters exported so the CMotionAnalysisUI module can share state without a cycle.
export function setCv(v) { cv = v; }
export function getCv() { return cv; }
export function setAnalyzeWithEffects(v) { analyzeWithEffects = v; }
export function getAnalyzeWithEffects() { return analyzeWithEffects; }

export function mt(key, options = undefined) {
    return t(`motionAnalysis.${key}`, options);
}

export function setMenuItemLabel(menuItem, key, options = undefined) {
    if (menuItem) {
        menuItem.name(mt(key, options));
    }
}

export function getVideoEffectsFilterString() {
    let filter = '';
    const contrast = NodeMan.get("videoContrast", false);
    const brightness = NodeMan.get("videoBrightness", false);
    const blur = NodeMan.get("videoBlur", false);
    const hue = NodeMan.get("videoHue", false);
    const invert = NodeMan.get("videoInvert", false);
    const saturate = NodeMan.get("videoSaturate", false);
    
    if (contrast && contrast.v0 !== 1) filter += `contrast(${contrast.v0}) `;
    if (brightness && brightness.v0 !== 1) filter += `brightness(${brightness.v0}) `;
    if (blur && blur.v0 !== 0) filter += `blur(${blur.v0}px) `;
    if (hue && hue.v0 !== 0) filter += `hue-rotate(${hue.v0}deg) `;
    if (invert && invert.v0 !== 0) filter += `invert(${invert.v0}) `;
    if (saturate && saturate.v0 !== 1) filter += `saturate(${saturate.v0}) `;
    
    return filter || 'none';
}

export function applyVideoEffectsToCanvas(ctx, width, height) {
    const convolutionFilter = NodeMan.get("videoConvolutionFilter", false);
    if (convolutionFilter && convolutionFilter.value !== 'none') {
        const sharpenAmount = NodeMan.get("videoSharpenAmount", false);
        const edgeDetectThreshold = NodeMan.get("videoEdgeDetectThreshold", false);
        const embossDepth = NodeMan.get("videoEmbossDepth", false);
        const params = {
            amount: sharpenAmount?.v0 ?? 1,
            threshold: edgeDetectThreshold?.v0 ?? 0,
            strength: convolutionFilter.value === 'emboss' ? (embossDepth?.v0 ?? 1) : 1
        };
        applyConvolution(ctx, width, height, convolutionFilter.value, params);
    }
}

export async function ensureOpenCVAndAnalyzer(menuItem, loadingText, defaultText) {
    const videoView = NodeMan.get("video", false);
    if (!videoView) {
        alert(mt("errors.noVideoView"));
        return null;
    }

    const videoData = videoView.videoData;
    if (!videoData) {
        alert(mt("errors.noVideoData"));
        return null;
    }

    if (!cv) {
        if (menuItem) menuItem.name(loadingText);
        try {
            await loadOpenCV();
            cv = getCV();
        } catch (e) {
            alert(mt("errors.failedToLoadOpenCv", {message: e.message}));
            if (menuItem) menuItem.name(defaultText);
            return null;
        }
    }

    startAnalysis(videoView);

    return {videoView, videoData};
}


export function imageToGrayscale(image, blurSize) {
    const width = image.width || image.videoWidth;
    const height = image.height || image.videoHeight;
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext('2d');
    
    if (analyzeWithEffects) {
        tempCtx.filter = getVideoEffectsFilterString();
    }
    tempCtx.drawImage(image, 0, 0, width, height);
    tempCtx.filter = 'none';
    
    if (analyzeWithEffects) {
        applyVideoEffectsToCanvas(tempCtx, width, height);
    }
    
    const imageData = tempCtx.getImageData(0, 0, width, height);

    const src = cv.matFromImageData(imageData);
    const grayRaw = new cv.Mat();
    cv.cvtColor(src, grayRaw, cv.COLOR_RGBA2GRAY);
    src.delete();

    const gray = new cv.Mat();
    const blur = Math.max(1, Math.floor(blurSize) | 1);
    if (blur > 1) {
        cv.GaussianBlur(grayRaw, gray, new cv.Size(blur, blur), 0);
        grayRaw.delete();
    } else {
        grayRaw.copyTo(gray);
        grayRaw.delete();
    }

    return {gray, width, height};
}

export const MOTION_TECHNIQUES = {
    SPARSE_CONSENSUS: 'Sparse + Consensus',
    LINEAR_TRACKLET: 'Linear Tracklet',
    PHASE_CORRELATION: 'Phase Correlation',
    ECC_EUCLIDEAN: 'ECC Euclidean',
    AFFINE_RANSAC: 'Affine RANSAC',
};

const DUPLICATE_IDENTICAL_RATIO = 0.93;
const DUPLICATE_MEAN_ABS_DIFF = 0.15;

export class MotionAnalyzer {
    constructor(videoView) {
        this.videoView = videoView;
        this.active = false;
        this.overlaysCreated = false;
        this.overlay = null;
        this.overlayCtx = null;
        this.graphCanvas = null;
        this.graphCtx = null;
        
        this.params = {
            technique: MOTION_TECHNIQUES.LINEAR_TRACKLET,
            maxFeatures: 300,
            qualityLevel: 0.01,
            minDistance: 10,
            blurSize: 5,
            frameSkip: 3,
            minMotion: 0.2,
            maxMotion: 100,
            minQuality: 0.3,
            maxTrackError: 15,
            staticThreshold: 0.3,
            staticFrames: 15,
            smoothingAlpha: 0.9,
            inlierThreshold: 0.6,
            rejectMovingObjects: true,    // fit a global affine background transform (IRLS) and drop independently-moving objects
            objectRejectThreshold: 3.0,   // max reprojection residual (px) for a vector to count as background
            eccIterations: 50,
            eccEpsilon: 0.001,
            ransacThreshold: 3.0,
            minVectorCount: 5,
            minConsensusConfidence: 0.1,
            linearityThreshold: 0.9,
            spacingThreshold: 0.5,
            skipDuplicateFrames: true,
        };
        
        this.frameBuffer = [];
        this.maxBufferSize = 10;
        this.staticHistory = new Map();
        
        this.angleHistory = [];
        this.maxHistoryLength = 300;
        
        this.smoothedDirection = {x: 0, y: 0, angle: 0, magnitude: 0, confidence: 0};
        
        this.lastFlowData = null;
        this.guiFolder = null;
        
        this.maskOverlayNode = null;
        this.maskEnabled = true;
        this.brushSize = 20;
        
        this.speedOverlayNode = null;
        this.speedOverlayEnabled = false;
        
        this.autoMaskWindow = 10;
        this.autoMaskThreshold = 0.9;
        this.autoMaskSpread = 5;
        this.autoMaskTargetColor = {r: 235, g: 235, b: 235};
        this.autoMaskCloseToTarget = 140;

        // "Auto Mask Redactions": detect solid black/grey rectangular redaction
        // boxes (which are temporally invariant because they cover the content)
        // and mask them. See autoMaskRedactions().
        this.redactionWindow = 8;        // frames analysed for temporal invariance
        this.redactionInvariance = 5;    // max % luminance change to count as invariant
        this.redactionMaxLuma = 180;     // ignore pixels brighter than this (bright-sky guard)
        this.redactionFlatness = 10;     // max local luminance variation to count as a flat solid fill
        this.redactionMinSize = 12;      // min box width AND height in pixels
        this.redactionFill = 0.6;        // min fraction of a region that must be covered by rectangles
        this.redactionSnap = 6;          // max sliver width (px) to bridge between adjacent boxes
        this.redactionSpread = 8;        // expand each detected box outward by this many pixels
        this.redactionRects = [];        // last-applied redaction rects (informational)

        this.resultCache = new Map();
        this.duplicateFrameCache = new Map();
        this.suspendAnalysis = false;
        this.lastAFrame = null;
        this.lastBFrame = null;
        this.lastVideoDataId = null;
        
        this.optimizing = false;
        this.optimizeAborted = false;
        this.optimizePopulation = [];
        this.optimizeBestParams = null;
        this.optimizeBestFitness = -Infinity;
        this.optimizeGeneration = 0;
        this.optimizeNoImproveCount = 0;
        this.optimizeParamsBeforeStart = null;
    }
    
    invalidateCache() {
        console.log("invalidateCache called, technique=" + this.params.technique);
        this.resultCache.clear();
        this.duplicateFrameCache.clear();
        this.frameBuffer = [];
        this.staticHistory.clear();
        this.angleHistory = [];
        this.smoothedDirection = {x: 0, y: 0, angle: 0, magnitude: 0, confidence: 0, rotation: 0};
        this.lastFlowData = null;
    }

    makeZeroMotionFlowData(isDuplicateFrame = false) {
        return {
            vectors: [],
            consensus: {dx: 0, dy: 0, confidence: 1, inlierCount: 0, duplicateFrame: isDuplicateFrame},
            isGoodFrame: true,
            duplicateFrame: isDuplicateFrame,
        };
    }

    getZeroMotionDirection() {
        return {x: 0, y: 0, angle: 0, magnitude: 0, confidence: 1, rotation: 0};
    }

    compareGrayForDuplicate(grayA, grayB) {
        if (!grayA || !grayB || grayA.rows !== grayB.rows || grayA.cols !== grayB.cols) {
            return {isDuplicate: false, identicalRatio: 0, meanAbsDiff: Infinity};
        }

        const a = grayA.data;
        const b = grayB.data;
        const n = Math.min(a.length, b.length);
        if (n === 0) return {isDuplicate: false, identicalRatio: 0, meanAbsDiff: Infinity};

        const stride = Math.max(1, Math.floor(n / 50000));
        let identical = 0;
        let totalDiff = 0;
        let samples = 0;
        for (let i = 0; i < n; i += stride) {
            const diff = Math.abs(a[i] - b[i]);
            if (diff === 0) identical++;
            totalDiff += diff;
            samples++;
        }

        const identicalRatio = identical / samples;
        const meanAbsDiff = totalDiff / samples;
        return {
            isDuplicate: identicalRatio >= DUPLICATE_IDENTICAL_RATIO && meanAbsDiff <= DUPLICATE_MEAN_ABS_DIFF,
            identicalRatio,
            meanAbsDiff,
        };
    }

    detectDuplicateFrame(frame, gray) {
        if (!this.params.skipDuplicateFrames || frame <= 0) {
            return {isDuplicate: false, identicalRatio: 0, meanAbsDiff: Infinity};
        }

        const cached = this.duplicateFrameCache.get(frame);
        if (cached) return cached;

        const videoData = this.videoView?.videoData;
        const prevImage = videoData?.getImage(frame - 1);
        if (!prevImage || !prevImage.width || !prevImage.height) {
            const result = {isDuplicate: false, identicalRatio: 0, meanAbsDiff: Infinity};
            this.duplicateFrameCache.set(frame, result);
            return result;
        }

        const {gray: prevGray} = imageToGrayscale(prevImage, this.params.blurSize);
        const result = this.compareGrayForDuplicate(prevGray, gray);
        prevGray.delete();
        this.duplicateFrameCache.set(frame, result);
        return result;
    }

    async buildDuplicateFrameMap(startFrame, endFrame, progressCallback = null, beforeFrameCallback = null, shouldCancel = null) {
        if (!this.params.skipDuplicateFrames) return;

        const videoData = this.videoView?.videoData;
        if (!videoData) return;

        let prevGray = null;
        let prevFrame = Math.max(0, startFrame - 1);
        if (prevFrame < startFrame) {
            beforeFrameCallback?.(prevFrame);
            videoData.getImage(prevFrame);
            await videoData.waitForFrame?.(prevFrame, 5000);
            const prevImage = videoData.getImageNoPurge?.(prevFrame) || videoData.getImage(prevFrame);
            if (prevImage?.width && prevImage?.height) {
                prevGray = imageToGrayscale(prevImage, this.params.blurSize).gray;
            }
        }

        const total = endFrame - startFrame + 1;
        for (let f = startFrame; f <= endFrame; f++) {
            if (shouldCancel?.()) break;   // cooperative cancel (Stop Analysis during the dup scan)
            beforeFrameCallback?.(f);
            videoData.getImage(f);
            await videoData.waitForFrame?.(f, 5000);
            const image = videoData.getImageNoPurge?.(f) || videoData.getImage(f);

            if (!image?.width || !image?.height) {
                this.duplicateFrameCache.set(f, {isDuplicate: false, identicalRatio: 0, meanAbsDiff: Infinity});
                continue;
            }

            const {gray} = imageToGrayscale(image, this.params.blurSize);
            const result = prevGray
                ? this.compareGrayForDuplicate(prevGray, gray)
                : {isDuplicate: false, identicalRatio: 0, meanAbsDiff: Infinity};
            this.duplicateFrameCache.set(f, result);

            if (prevGray) prevGray.delete();
            prevGray = gray;

            if (progressCallback && ((f - startFrame) % 5 === 0 || f === endFrame)) {
                progressCallback(f - startFrame + 1, total);
                await new Promise(r => setTimeout(r, 0));
            }
        }

        if (prevGray) prevGray.delete();
    }

    hasDuplicateFrameMapForRange(startFrame, endFrame) {
        if (!this.params.skipDuplicateFrames) return true;
        for (let f = Math.max(1, startFrame); f <= endFrame; f++) {
            if (!this.duplicateFrameCache.has(f)) return false;
        }
        return true;
    }

    cacheZeroMotionFrame(frame, imgWidth, imgHeight, duplicateInfo = null) {
        const flowData = this.makeZeroMotionFlowData(!!duplicateInfo?.isDuplicate);
        if (duplicateInfo) {
            flowData.duplicateInfo = duplicateInfo;
        }
        const zeroDirection = this.getZeroMotionDirection();
        this.lastFlowData = flowData;
        this.resultCache.set(frame, {
            flowData,
            smoothedDirection: zeroDirection,
            angleHistory: [...this.angleHistory],
            imgWidth,
            imgHeight,
        });
    }

    getPriorAnalysisFrame(frame, skipFrames) {
        if (!this.params.skipDuplicateFrames) return frame - skipFrames;

        let remaining = skipFrames;
        for (let f = frame - 1; f >= 0; f--) {
            const duplicateInfo = this.duplicateFrameCache.get(f);
            if (duplicateInfo?.isDuplicate) continue;
            remaining--;
            if (remaining === 0) return f;
        }
        return -1;
    }

    async fillBadNonDuplicateMotionGap(frame, beforeFrameCallback = null) {
        if (!this.params.skipDuplicateFrames) return;

        const duplicateInfo = this.duplicateFrameCache.get(frame);
        if (duplicateInfo?.isDuplicate) return;

        const cached = this.resultCache.get(frame);
        if (!cached || cached.incomplete) return;
        if (cached.flowData?.isGoodFrame && !cached.flowData?.syntheticFrame && cached.flowData?.lastSegmentConsensus) return;

        const savedFrameSkip = this.params.frameSkip;
        let adjacent;
        try {
            this.params.frameSkip = 1;
            const sourceFrames = this.getTrackletSourceFrames(frame, 1);
            const videoData = this.videoView?.videoData;
            if (sourceFrames && videoData) {
                for (const sourceFrame of sourceFrames) {
                    beforeFrameCallback?.(sourceFrame);
                    videoData.getImage(sourceFrame);
                }
                for (const sourceFrame of sourceFrames) {
                    beforeFrameCallback?.(sourceFrame);
                    await videoData.waitForFrame?.(sourceFrame, 5000);
                }
            }
            adjacent = this.computeLinearTracklet(frame, cached.imgWidth, cached.imgHeight, 1, beforeFrameCallback);
        } finally {
            this.params.frameSkip = savedFrameSkip;
        }

        if (!adjacent?.consensus) return;

        const adjacentFlowData = {
            vectors: adjacent.flowVectors,
            consensus: adjacent.consensus,
            lastSegmentConsensus: adjacent.lastSegmentConsensus ?? adjacent.consensus,
            isGoodFrame: true,
            adjacentFallbackFrame: true,
        };
        const adjacentDirection = {
            x: adjacent.consensus.dx,
            y: adjacent.consensus.dy,
            angle: Math.atan2(adjacent.consensus.dy, adjacent.consensus.dx),
            magnitude: Math.sqrt(adjacent.consensus.dx * adjacent.consensus.dx + adjacent.consensus.dy * adjacent.consensus.dy),
            confidence: adjacent.consensus.confidence ?? 0,
            rotation: 0,
        };

        this.resultCache.set(frame, {
            ...cached,
            flowData: adjacentFlowData,
            smoothedDirection: adjacentDirection,
        });
    }

    async fillBadNonDuplicateMotionGaps(startFrame, endFrame, beforeFrameCallback = null, progressCallback = null, shouldCancel = null) {
        if (!this.params.skipDuplicateFrames) return;

        const total = endFrame - startFrame + 1;
        for (let f = startFrame; f <= endFrame; f++) {
            if (shouldCancel?.()) return;   // cooperative cancel (Stop Analysis during gap-fill)
            await this.fillBadNonDuplicateMotionGap(f, beforeFrameCallback);
            if (progressCallback && ((f - startFrame) % 5 === 0 || f === endFrame)) {
                progressCallback(f - startFrame + 1, total);
                await new Promise(r => setTimeout(r, 0));
            }
        }

        const goodFrames = [];
        for (let f = startFrame; f <= endFrame; f++) {
            const duplicateInfo = this.duplicateFrameCache.get(f);
            const cached = this.resultCache.get(f);
            const cons = cached?.flowData?.consensus;
            if (duplicateInfo?.isDuplicate) continue;
            if (cached?.flowData?.isGoodFrame && cons) {
                goodFrames.push(f);
            }
        }
        if (goodFrames.length === 0) return;

        for (let f = startFrame; f <= endFrame; f++) {
            const duplicateInfo = this.duplicateFrameCache.get(f);
            if (duplicateInfo?.isDuplicate) continue;

            const cached = this.resultCache.get(f);
            if (cached?.flowData?.isGoodFrame && cached.flowData.consensus) continue;
            if (!cached || cached.incomplete) continue;

            let prevGood = null;
            let nextGood = null;
            for (const gf of goodFrames) {
                if (gf < f) prevGood = gf;
                if (gf > f) {
                    nextGood = gf;
                    break;
                }
            }

            let dx = 0, dy = 0, confidence = 0;
            let lastDx = 0, lastDy = 0, lastConfidence = 0;
            if (prevGood !== null && nextGood !== null) {
                const prevFlow = this.resultCache.get(prevGood).flowData;
                const nextFlow = this.resultCache.get(nextGood).flowData;
                const prev = prevFlow.consensus;
                const next = nextFlow.consensus;
                const prevLast = prevFlow.lastSegmentConsensus ?? prev;
                const nextLast = nextFlow.lastSegmentConsensus ?? next;
                const t = (f - prevGood) / (nextGood - prevGood);
                dx = prev.dx + t * (next.dx - prev.dx);
                dy = prev.dy + t * (next.dy - prev.dy);
                confidence = Math.min(prev.confidence ?? 0, next.confidence ?? 0) * 0.5;
                lastDx = prevLast.dx + t * (nextLast.dx - prevLast.dx);
                lastDy = prevLast.dy + t * (nextLast.dy - prevLast.dy);
                lastConfidence = Math.min(prevLast.confidence ?? 0, nextLast.confidence ?? 0) * 0.5;
            } else if (prevGood !== null) {
                const prevFlow = this.resultCache.get(prevGood).flowData;
                const prev = prevFlow.consensus;
                const prevLast = prevFlow.lastSegmentConsensus ?? prev;
                dx = prev.dx;
                dy = prev.dy;
                confidence = (prev.confidence ?? 0) * 0.5;
                lastDx = prevLast.dx;
                lastDy = prevLast.dy;
                lastConfidence = (prevLast.confidence ?? 0) * 0.5;
            } else if (nextGood !== null) {
                const nextFlow = this.resultCache.get(nextGood).flowData;
                const next = nextFlow.consensus;
                const nextLast = nextFlow.lastSegmentConsensus ?? next;
                dx = next.dx;
                dy = next.dy;
                confidence = (next.confidence ?? 0) * 0.5;
                lastDx = nextLast.dx;
                lastDy = nextLast.dy;
                lastConfidence = (nextLast.confidence ?? 0) * 0.5;
            }

            const syntheticFlowData = {
                vectors: [],
                consensus: {dx, dy, confidence, inlierCount: 0, synthetic: true},
                lastSegmentConsensus: {dx: lastDx, dy: lastDy, confidence: lastConfidence, inlierCount: 0, synthetic: true},
                isGoodFrame: true,
                syntheticFrame: true,
            };
            const syntheticDirection = {
                x: dx,
                y: dy,
                angle: Math.atan2(dy, dx),
                magnitude: Math.sqrt(dx * dx + dy * dy),
                confidence,
                rotation: 0,
            };

            this.resultCache.set(f, {
                ...cached,
                flowData: syntheticFlowData,
                smoothedDirection: syntheticDirection,
            });
        }
    }

    getCacheStatusArray() {
        const status = new Array(Sit.frames).fill(0);
        for (let f = 0; f < Sit.frames; f++) {
            const cached = this.resultCache.get(f);
            // Only show as cached if complete (not incomplete)
            if (cached && !cached.incomplete) {
                status[f] = 1;
            }
        }
        return status;
    }

    isCacheFull() {
        const aFrame = Sit.aFrame || 0;
        const bFrame = Sit.bFrame ?? (Sit.frames - 1);
        for (let f = aFrame; f <= bFrame; f++) {
            const cached = this.resultCache.get(f);
            // Check that frame is cached AND not incomplete
            if (!cached || cached.incomplete) {
                return false;
            }
        }
        return true;
    }

    // gapFill=true: smooth-curve mode (default). Frames flagged !isGoodFrame
    //   are interpolated from their nearest good neighbours — appropriate for
    //   velocity tracks and motion visualization where occasional bad frames
    //   shouldn't introduce visible discontinuities.
    // gapFill=false: frame-accurate mode. Trust the measured per-frame
    //   consensus even when isGoodFrame=false, because a genuinely stationary
    //   scene legitimately produces near-zero motion that fails the
    //   minVectorCount / minConsensusConfidence quality threshold. Used by
    //   panorama assembly and video stabilization, which need each frame's
    //   actual offset — zero must stay zero, not get blended with neighbours.
    getMotionDataForAllFrames(options = {}) {
        const {gapFill = true, fallbackToSmoothed = true, useTrackletLastSegment = false} = options;
        const data = [];
        const goodFrameIndices = [];

        for (let f = 0; f < Sit.frames; f++) {
            const cached = this.resultCache.get(f);
            if (cached && cached.smoothedDirection && !cached.incomplete) {
                const cons = useTrackletLastSegment
                    ? (cached.flowData?.lastSegmentConsensus ?? cached.flowData?.consensus)
                    : cached.flowData?.consensus;
                const isGoodFrame = cached.flowData?.isGoodFrame ?? true;
                if (isGoodFrame || !gapFill) {
                    data.push({
                        dx: cons?.dx ?? (fallbackToSmoothed ? cached.smoothedDirection.x : 0) ?? 0,
                        dy: cons?.dy ?? (fallbackToSmoothed ? cached.smoothedDirection.y : 0) ?? 0,
                        confidence: cons?.confidence ?? (fallbackToSmoothed ? cached.smoothedDirection.confidence : 0) ?? 0,
                        isGood: isGoodFrame,
                    });
                    if (isGoodFrame) goodFrameIndices.push(f);
                } else {
                    data.push({dx: 0, dy: 0, confidence: 0, isGood: false});
                }
            } else {
                data.push({dx: 0, dy: 0, confidence: 0, isGood: false});
            }
        }

        if (!gapFill || goodFrameIndices.length === 0) {
            return data;
        }

        for (let f = 0; f < Sit.frames; f++) {
            if (data[f].isGood) continue;
            
            let prevGoodIdx = -1;
            let nextGoodIdx = -1;
            
            for (let i = goodFrameIndices.length - 1; i >= 0; i--) {
                if (goodFrameIndices[i] < f) {
                    prevGoodIdx = goodFrameIndices[i];
                    break;
                }
            }
            for (let i = 0; i < goodFrameIndices.length; i++) {
                if (goodFrameIndices[i] > f) {
                    nextGoodIdx = goodFrameIndices[i];
                    break;
                }
            }
            
            if (prevGoodIdx < 0 && nextGoodIdx >= 0) {
                data[f] = {...data[nextGoodIdx], confidence: data[nextGoodIdx].confidence * 0.5};
            } else if (nextGoodIdx < 0 && prevGoodIdx >= 0) {
                data[f] = {...data[prevGoodIdx], confidence: data[prevGoodIdx].confidence * 0.5};
            } else if (prevGoodIdx >= 0 && nextGoodIdx >= 0) {
                const t = (f - prevGoodIdx) / (nextGoodIdx - prevGoodIdx);
                const prev = data[prevGoodIdx];
                const next = data[nextGoodIdx];
                data[f] = {
                    dx: prev.dx + t * (next.dx - prev.dx),
                    dy: prev.dy + t * (next.dy - prev.dy),
                    confidence: Math.min(prev.confidence, next.confidence) * 0.5,
                    isGood: false,
                };
            }
        }
        
        return data;
    }

    getGapFilledDirection(frame) {
        let prevGoodIdx = -1;
        let nextGoodIdx = -1;
        
        for (let f = frame - 1; f >= 0; f--) {
            const cached = this.resultCache.get(f);
            if (cached && cached.flowData?.isGoodFrame && cached.smoothedDirection) {
                prevGoodIdx = f;
                break;
            }
        }
        
        for (let f = frame + 1; f < Sit.frames; f++) {
            const cached = this.resultCache.get(f);
            if (cached && cached.flowData?.isGoodFrame && cached.smoothedDirection) {
                nextGoodIdx = f;
                break;
            }
        }
        
        if (prevGoodIdx < 0 && nextGoodIdx < 0) {
            return null;
        }
        
        if (prevGoodIdx < 0 && nextGoodIdx >= 0) {
            const next = this.resultCache.get(nextGoodIdx).smoothedDirection;
            return {...next, confidence: next.confidence * 0.5};
        }
        
        if (nextGoodIdx < 0 && prevGoodIdx >= 0) {
            const prev = this.resultCache.get(prevGoodIdx).smoothedDirection;
            return {...prev, confidence: prev.confidence * 0.5};
        }
        
        const t = (frame - prevGoodIdx) / (nextGoodIdx - prevGoodIdx);
        const prev = this.resultCache.get(prevGoodIdx).smoothedDirection;
        const next = this.resultCache.get(nextGoodIdx).smoothedDirection;
        
        const x = prev.x + t * (next.x - prev.x);
        const y = prev.y + t * (next.y - prev.y);
        return {
            x, y,
            angle: Math.atan2(y, x),
            magnitude: Math.sqrt(x * x + y * y),
            confidence: Math.min(prev.confidence, next.confidence) * 0.5,
            rotation: prev.rotation + t * (next.rotation - prev.rotation),
        };
    }

    findNextUncachedOrGoodFrame(fromFrame) {
        const skipFrames = Math.max(1, Math.round(this.params.frameSkip));
        const startSearch = fromFrame + skipFrames;
        for (let f = startSearch; f < Sit.frames; f++) {
            const cached = this.resultCache.get(f);
            if (!cached) return f;
            if (cached.flowData?.isGoodFrame) return null;
        }
        return null;
    }

    analyzeFrameForGapFill(targetFrame) {
        if (!this.active || !cv) return;
        const videoData = this.videoView?.videoData;
        if (!videoData) return;
        
        const cached = this.resultCache.get(targetFrame);
        if (cached && !cached.incomplete) return;
        
        const image = videoData.getImage(targetFrame);
        if (!image || !image.width) return;
        
        const {gray, width, height} = imageToGrayscale(image, this.params.blurSize);

        const duplicateInfo = this.detectDuplicateFrame(targetFrame, gray);
        if (duplicateInfo.isDuplicate) {
            gray.delete();
            this.cacheZeroMotionFrame(targetFrame, width, height, duplicateInfo);
            setRenderOne(true);
            return;
        }

        this.frameBuffer.push({gray: gray.clone(), frame: targetFrame, width, height});
        while (this.frameBuffer.length > this.maxBufferSize) {
            const old = this.frameBuffer.shift();
            if (old.gray) old.gray.delete();
        }

        const skipFrames = Math.max(1, Math.round(this.params.frameSkip));
        
        if (this.params.technique === MOTION_TECHNIQUES.LINEAR_TRACKLET) {
            this.computeOpticalFlowLinearTracklet(targetFrame, width, height, skipFrames);
        }
        
        gray.delete();

        this.resultCache.set(targetFrame, {
            flowData: this.lastFlowData ? {...this.lastFlowData, vectors: [...this.lastFlowData.vectors]} : null,
            smoothedDirection: {...this.smoothedDirection},
            angleHistory: [...this.angleHistory],
            imgWidth: width,
            imgHeight: height,
        });

        setRenderOne(true);
    }

    getImageDimensions() {
        const videoData = this.videoView?.videoData;
        if (!videoData) return {width: 1920, height: 1080};
        const image = videoData.getImage(0);
        return {
            width: image?.width || image?.videoWidth || 1920,
            height: image?.height || image?.videoHeight || 1080,
        };
    }
    
    onParamChange() {
        this.invalidateCache();
        setRenderOne(true);
    }
    
    onMaskChange() {
        this.invalidateCache();
        setRenderOne(true);
    }
    
    setMaskEditing(enabled) {
        if (this.maskOverlayNode) {
            this.maskOverlayNode.setEditing(enabled);
            setRenderOne(true);
        }
    }
    
    updateMaskPreview() {
        if (this.maskOverlayNode) {
            this.maskOverlayNode.setShowMaskPreview(this.maskEnabled);
            setRenderOne(true);
        }
    }
    
    clearMask() {
        if (this.maskOverlayNode) {
            this.maskOverlayNode.clearMask();
        }
        // Drop the auto-mask baselines so the next auto run starts from the (now
        // empty) mask rather than restoring stale content.
        this._autoMaskBaselines = {};
    }

    // Apply one auto-mask "layer" (keyed by `name`) additively and idempotently.
    // `drawFn(ctx, canvas)` paints the layer's primitives in mask-canvas pixels.
    //
    // The mask is shared by hand-painting, the text "Auto Mask", and "Auto Mask
    // Redactions". To add this layer without wiping the rest, and without stacking
    // when the same tool is re-run (e.g. while dragging a slider), we keep a
    // per-layer baseline = the mask as it was just before this layer last drew:
    //   - if the mask is still exactly as this layer last left it (revision match),
    //     restore that baseline (removing only this layer's previous output) and
    //     redraw — so re-running replaces this layer's contribution, not the others;
    //   - otherwise something else changed the mask (paint / clear / the other auto
    //     tool), so snapshot the current mask as the new baseline and draw on top,
    //     i.e. genuinely add to whatever is there now.
    // Returns true on success.
    _applyAutoMaskLayer(name, drawFn) {
        const overlay = this.maskOverlayNode;
        if (!overlay) return false;
        overlay.ensureMaskInitialized();
        const canvas = overlay.maskCanvas;
        if (!canvas) return false;

        this._autoMaskBaselines = this._autoMaskBaselines || {};
        const state = this._autoMaskBaselines[name];
        const rev = overlay.maskRevision || 0;

        // Mask untouched since this layer last drew → replace our own previous
        // contribution (restore baseline). Otherwise add to the current mask.
        const replacingOwn = !!(state && rev === state.appliedRev
            && state.width === canvas.width && state.height === canvas.height);
        const baseline = replacingOwn ? state.baseline
            : overlay.maskCtx.getImageData(0, 0, canvas.width, canvas.height);

        // One undoable edit; re-runs that merely replace this layer's own output
        // (e.g. while a slider drags) coalesce into the previous undo entry, so a
        // single undo removes the whole auto-mask application.
        overlay.applyMaskEdit(`Auto mask (${name})`, (ctx, cvs) => {
            ctx.putImageData(baseline, 0, 0);
            ctx.globalCompositeOperation = 'source-over';
            drawFn(ctx, cvs);
        }, {coalesceKey: `autoMask:${name}`, coalesce: replacingOwn});

        this._autoMaskBaselines[name] = {
            baseline,
            appliedRev: overlay.maskRevision,
            width: canvas.width,
            height: canvas.height,
        };
        return true;
    }

    autoMask() {
        const videoData = this.videoView?.videoData;
        if (!videoData) {
            console.log("AutoMask: no videoData");
            return;
        }
        
        const currentFrame = Math.floor(par.frame);
        const endFrame = Math.min(currentFrame + this.autoMaskWindow, Sit.frames - 1);
        console.log(`AutoMask: currentFrame=${currentFrame}, endFrame=${endFrame}, window=${this.autoMaskWindow}`);
        
        if (endFrame <= currentFrame) {
            console.log("AutoMask: endFrame <= currentFrame");
            return;
        }
        
        const firstImage = videoData.getImage(currentFrame);
        console.log(`AutoMask: firstImage=`, firstImage, `width=${firstImage?.width}, videoWidth=${firstImage?.videoWidth}`);
        if (!firstImage || !firstImage.width) {
            console.log("AutoMask: no firstImage or no width");
            return;
        }
        
        const width = firstImage.width || firstImage.videoWidth;
        const height = firstImage.height || firstImage.videoHeight;
        console.log(`AutoMask: dimensions ${width}x${height}`);
        
        const frames = [];
        for (let f = currentFrame; f <= endFrame; f++) {
            const isLoaded = videoData.isFrameLoaded ? videoData.isFrameLoaded(f) : true;
            if (!isLoaded) {
                console.log(`AutoMask: frame ${f} not loaded yet`);
                continue;
            }
            const img = videoData.getImage(f);
            if (!img || !img.width) {
                console.log(`AutoMask: frame ${f} not available`);
                continue;
            }
            
            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);
            const imageData = ctx.getImageData(0, 0, width, height);
            const sample = [imageData.data[0], imageData.data[1], imageData.data[2]];
            console.log(`AutoMask: frame ${f} sample pixel RGB: ${sample}`);
            frames.push(imageData);
        }
        
        console.log(`AutoMask: loaded ${frames.length} frames`);
        if (frames.length < 2) {
            console.log("AutoMask: not enough frames");
            return;
        }
        
        this.maskOverlayNode.ensureMaskInitialized();
        if (!this.maskOverlayNode.maskCanvas) {
            console.log("AutoMask: maskCanvas not initialized");
            return;
        }

        const threshold = (1 - this.autoMaskThreshold) * 255;
        const {r: targetR, g: targetG, b: targetB} = this.autoMaskTargetColor;
        const targetThreshold = this.autoMaskCloseToTarget;
        console.log(`AutoMask: threshold=${threshold}, targetColor=(${targetR},${targetG},${targetB}), targetThreshold=${targetThreshold}`);
        const invariantPixels = [];
        
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = (y * width + x) * 4;
                const baseR = frames[0].data[idx];
                const baseG = frames[0].data[idx + 1];
                const baseB = frames[0].data[idx + 2];
                
                const targetDiff = Math.abs(baseR - targetR) + Math.abs(baseG - targetG) + Math.abs(baseB - targetB);
                if (targetDiff > targetThreshold) {
                    continue;
                }
                
                let isInvariant = true;
                for (let f = 1; f < frames.length; f++) {
                    const r = frames[f].data[idx];
                    const g = frames[f].data[idx + 1];
                    const b = frames[f].data[idx + 2];
                    
                    const diff = Math.abs(r - baseR) + Math.abs(g - baseG) + Math.abs(b - baseB);
                    if (diff > threshold * 3) {
                        isInvariant = false;
                        break;
                    }
                }
                
                if (isInvariant) {
                    invariantPixels.push({x, y});
                }
            }
        }
        
        console.log(`AutoMask: found ${invariantPixels.length} invariant pixels`);

        // Add the text mask to whatever is already there (idempotent per layer);
        // use Clear Mask to start fresh.
        const spread = this.autoMaskSpread;
        this._applyAutoMaskLayer('text', (ctx) => {
            ctx.fillStyle = 'rgba(255, 0, 0, 1)';
            for (const {x, y} of invariantPixels) {
                ctx.beginPath();
                ctx.arc(x, y, spread, 0, Math.PI * 2);
                ctx.fill();
            }
        });

        this.onMaskChange();
        setRenderOne(true);
        console.log("AutoMask: complete");
    }

    // Load a window of decoded frames as ImageData, centred on `centerFrame`.
    // Returns {frames, width, height} or null. Unlike a pure cache read, this
    // actively decodes each frame (await waitForFrame) so the temporal-invariance
    // test has real evidence; frames that still fail to decode are skipped.
    // The window is centred and clamped to [0, Sit.frames-1] so it never collapses
    // to a single frame near the clip ends (which would defeat invariance).
    async _loadMaskFrames(centerFrame, windowSize) {
        const videoData = this.videoView?.videoData;
        if (!videoData) return null;

        const lastFrame = Sit.frames - 1;
        const span = Math.max(2, Math.round(windowSize));
        const half = Math.floor(span / 2);
        let start = centerFrame - half;
        let end = start + span;
        if (start < 0) { end -= start; start = 0; }
        if (end > lastFrame) { start -= (end - lastFrame); end = lastFrame; }
        if (start < 0) start = 0;

        // Determine dimensions from the centre frame (decode it first).
        if (videoData.waitForFrame) { try { await videoData.waitForFrame(centerFrame, 4000); } catch (e) {} }
        const firstImage = videoData.getImage(centerFrame);
        if (!firstImage || !firstImage.width) return null;
        const width = firstImage.width || firstImage.videoWidth;
        const height = firstImage.height || firstImage.videoHeight;
        if (!width || !height) return null;

        const frames = [];
        for (let f = start; f <= end; f++) {
            if (videoData.waitForFrame) { try { await videoData.waitForFrame(f, 4000); } catch (e) {} }
            const isLoaded = videoData.isFrameLoaded ? videoData.isFrameLoaded(f) : true;
            if (!isLoaded) continue;
            const img = videoData.getImage(f);
            if (!img || !img.width) continue;

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;
            const ctx = canvas.getContext('2d', {willReadFrequently: true});
            ctx.drawImage(img, 0, 0, width, height);
            frames.push(ctx.getImageData(0, 0, width, height));
        }

        return {frames, width, height};
    }

    // "Auto Mask Redactions" — detect solid black/grey rectangular redaction
    // boxes and paint them into the mask. See detectRedactionRects() for the
    // detection details (grey + flat + temporally-invariant + rectilinear).
    //
    // Additive: the detected boxes are ADDED to the current mask (text Auto Mask,
    // hand-painting, etc.). Re-running — e.g. while tuning the sliders — replaces
    // only this tool's own boxes, not the rest. Use Clear Mask to start fresh.
    async autoMaskRedactions() {
        // Each call gets a monotonic id. The frame-loading await means several
        // runs (e.g. from dragging a slider) can overlap; only the most recent one
        // is allowed to write the mask so a slow earlier run can't overwrite it.
        const runId = (this._redactionRunId = (this._redactionRunId || 0) + 1);

        const currentFrame = Math.floor(par.frame);
        const loaded = await this._loadMaskFrames(currentFrame, this.redactionWindow);
        if (!loaded) {
            console.log("AutoMaskRedactions: no usable frames");
            return;
        }
        if (runId !== this._redactionRunId) return; // superseded by a newer run
        const {frames, width, height} = loaded;
        if (frames.length < 2) {
            console.log(`AutoMaskRedactions: need >=2 decoded frames (got ${frames.length})`);
            return;
        }

        if (!this.maskOverlayNode) {
            console.log("AutoMaskRedactions: no mask overlay");
            return;
        }

        const rects = detectRedactionRects(frames, width, height, {
            invariance: this.redactionInvariance,
            maxLuma: this.redactionMaxLuma,
            flatness: this.redactionFlatness,
            minSize: this.redactionMinSize,
            fill: this.redactionFill,
            snap: this.redactionSnap,
            spread: this.redactionSpread,
        });
        console.log(`AutoMaskRedactions: ${frames.length} frames, found ${rects.length} redaction rect(s)`);

        // Add the detected boxes to the current mask (idempotent per layer).
        this.redactionRects = rects;
        this._applyAutoMaskLayer('redaction', (ctx, canvas) => {
            // Map detection-space rects to mask-canvas pixels (normally identical).
            const sx = canvas.width / width;
            const sy = canvas.height / height;
            ctx.fillStyle = 'rgba(255, 0, 0, 1)';
            for (const r of rects) {
                ctx.fillRect(r.x * sx, r.y * sy, r.w * sx, r.h * sy);
            }
        });

        this.onMaskChange();
        setRenderOne(true);
        console.log("AutoMaskRedactions: complete");
    }

    // Create ONLY the mask overlay. Masking is usable as soon as a video is
    // loaded — it does not require a running motion-analysis pass — so this is
    // split out of createOverlays() and can be called standalone (e.g. when the
    // persistent Masking menu is first touched). Idempotent.
    ensureMaskOverlay() {
        if (this.maskOverlayNode) return this.maskOverlayNode;
        this.maskOverlayNode = new CNodeMaskOverlay({
            id: "motionMaskOverlay",
            overlayView: this.videoView,
            brushSize: this.brushSize,
            visible: false,
            onMaskChange: () => this.onMaskChange(),
        });
        return this.maskOverlayNode;
    }

    createOverlays() {
        if (this.overlaysCreated) return;
        this.overlaysCreated = true;

        // Reuses the mask overlay if it was already created for standalone masking.
        this.ensureMaskOverlay();

        this.speedOverlayNode = new CNodeSpeedOverlay({
            id: "motionSpeedOverlay",
            overlayView: this.videoView,
            visible: false,
        });
        this.speedOverlayNode.setMotionAnalyzer(this);

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
        
        this.graphCanvas = document.createElement('canvas');
        this.graphCanvas.style.position = 'absolute';
        this.graphCanvas.style.bottom = '10px';
        this.graphCanvas.style.right = '10px';
        this.graphCanvas.style.width = '200px';
        this.graphCanvas.style.height = '80px';
        this.graphCanvas.style.pointerEvents = 'none';
        this.graphCanvas.style.zIndex = '101';
        this.graphCanvas.style.background = 'rgba(0,0,0,0.5)';
        this.graphCanvas.style.borderRadius = '4px';
        this.graphCanvas.width = 200;
        this.graphCanvas.height = 80;
        this.videoView.div.appendChild(this.graphCanvas);
        this.graphCtx = this.graphCanvas.getContext('2d');
    }

    showOverlays() {
        if (this.overlay) this.overlay.style.display = 'block';
        if (this.graphCanvas) this.graphCanvas.style.display = 'block';
    }
    
    hideOverlays() {
        if (this.overlay) {
            this.overlay.style.display = 'none';
            this.overlayCtx.clearRect(0, 0, this.overlay.width, this.overlay.height);
        }
        if (this.graphCanvas) this.graphCanvas.style.display = 'none';
        if (this.maskOverlayNode) {
            this.maskOverlayNode.setShowMaskPreview(false);
            this.maskOverlayNode.setEditing(false);
        }
        if (this.speedOverlayNode) {
            this.speedOverlayNode.setEnabled(false);
        }
    }
    
    setSpeedOverlayEnabled(enabled) {
        this.speedOverlayEnabled = enabled;
        if (this.speedOverlayNode) {
            this.speedOverlayNode.setEnabled(enabled);
            setRenderOne(true);
        }
    }

    start() {
        this.active = true;
        this.createOverlays();
        this.showOverlays();
        this.updateMaskPreview();
        
        registerFrameBlocker('motionAnalysis', {
            check: (currentFrame, nextFrame) => {
                if (!this.active) return false;
                const current = Math.floor(currentFrame);
                if (current < 0 || current >= Sit.frames) return false;
                // Block if frame is not cached OR if it's cached but incomplete
                const cached = this.resultCache.get(current);
                return !cached || cached.incomplete;
            },
            requiresSingleFrame: () => {
                return this.active && !this.isCacheFull();
            }
        });
    }

    stop() {
        this.active = false;
        this.hideOverlays();
        this.clearSliderStatus();
        unregisterFrameBlocker('motionAnalysis');
    }

    analyze(frame) {
        frame = Math.floor(frame);
        if (!this.active || !cv) return;
        if (this.suspendAnalysis) return;

        const videoData = this.videoView.videoData;
        if (!videoData) return;

        const videoId = videoData.id || videoData.filename || 'unknown';
        if (this.lastVideoDataId !== videoId) {
            this.lastVideoDataId = videoId;
            this.invalidateCache();
        }
        
        if (this.lastAFrame !== Sit.aFrame || this.lastBFrame !== Sit.bFrame) {
            this.lastAFrame = Sit.aFrame;
            this.lastBFrame = Sit.bFrame;
            this.invalidateCache();
        }

        const width = this.videoView.widthPx;
        const height = this.videoView.heightPx;

        if (this.overlay.width !== width || this.overlay.height !== height) {
            this.overlay.width = width;
            this.overlay.height = height;
        }

        this.currentFlowRotation = getFlowAlignRotation(frame);

        const cached = this.resultCache.get(frame);
        if (cached && !cached.incomplete) {
            this.lastFlowData = cached.flowData;
            const isGoodFrame = cached.flowData?.isGoodFrame ?? true;
            if (isGoodFrame) {
                this.smoothedDirection = {...cached.smoothedDirection};
            } else {
                const gapFilled = this.getGapFilledDirection(frame);
                if (gapFilled) {
                    this.smoothedDirection = gapFilled;
                } else {
                    this.smoothedDirection = {...cached.smoothedDirection};
                }
            }
            this.angleHistory = [...cached.angleHistory];
            this.drawOverlay(width, height, cached.imgWidth, cached.imgHeight);
            this.drawGraph();
            return;
        }

        const image = videoData.getImage(frame);
        if (!image || !image.width || !image.height) {
            this.overlayCtx.clearRect(0, 0, width, height);
            this.resultCache.set(frame, {
                flowData: null,
                smoothedDirection: {...this.smoothedDirection},
                angleHistory: [...this.angleHistory],
                imgWidth: 0,
                imgHeight: 0,
                incomplete: true,
            });
            setTimeout(() => setRenderOne(true), 100);
            return;
        }

        const {gray, width: imgWidth, height: imgHeight} = imageToGrayscale(image, this.params.blurSize);
        
        if (this.maskOverlayNode) {
            this.maskOverlayNode.initMask(imgWidth, imgHeight);
        }

        const duplicateInfo = this.detectDuplicateFrame(frame, gray);
        if (duplicateInfo.isDuplicate) {
            gray.delete();
            this.cacheZeroMotionFrame(frame, imgWidth, imgHeight, duplicateInfo);
            this.drawOverlay(width, height, imgWidth, imgHeight);
            this.drawGraph();
            this.updateSliderStatus();
            return;
        }

        this.frameBuffer.push({gray: gray.clone(), frame, width: imgWidth, height: imgHeight});
        
        while (this.frameBuffer.length > this.maxBufferSize) {
            const old = this.frameBuffer.shift();
            if (old.gray) old.gray.delete();
        }

        const skipFrames = Math.max(1, Math.round(this.params.frameSkip));
        const targetFrame = this.getPriorAnalysisFrame(frame, skipFrames);
        let compareIdx = this.frameBuffer.findIndex(entry => entry.frame === targetFrame);
        
        if (compareIdx < 0 && targetFrame >= 0) {
            const prevFrame = targetFrame;
            const isLoaded = videoData.isFrameLoaded ? videoData.isFrameLoaded(prevFrame) : true;
            if (!isLoaded) {
                gray.delete();
                this.resultCache.set(frame, {
                    flowData: null,
                    smoothedDirection: {...this.smoothedDirection},
                    angleHistory: [...this.angleHistory],
                    imgWidth,
                    imgHeight,
                    incomplete: true,
                });
                setTimeout(() => setRenderOne(true), 100);
                return;
            }
            const prevImage = videoData.getImage(prevFrame);
            if (prevImage && prevImage.width && prevImage.height) {
                const {gray: prevGray, width: prevWidth, height: prevHeight} = imageToGrayscale(prevImage, this.params.blurSize);
                this.frameBuffer.unshift({gray: prevGray, frame: prevFrame, width: prevWidth, height: prevHeight});
                compareIdx = 0;
            }
        }
        
        if (this.params.technique === MOTION_TECHNIQUES.LINEAR_TRACKLET) {
            this.computeOpticalFlowLinearTracklet(frame, imgWidth, imgHeight, skipFrames);
            
            gray.delete();

            this.resultCache.set(frame, {
                flowData: this.lastFlowData ? {...this.lastFlowData, vectors: [...this.lastFlowData.vectors]} : null,
                smoothedDirection: {...this.smoothedDirection},
                angleHistory: [...this.angleHistory],
                imgWidth,
                imgHeight,
            });

            if (!(this.lastFlowData?.isGoodFrame)) {
                const gapFilled = this.getGapFilledDirection(frame);
                if (gapFilled) {
                    this.smoothedDirection = gapFilled;
                } else {
                    const nextGoodFrame = this.findNextUncachedOrGoodFrame(frame);
                    if (nextGoodFrame !== null && nextGoodFrame !== frame) {
                        setTimeout(() => {
                            this.analyzeFrameForGapFill(nextGoodFrame);
                        }, 10);
                    }
                }
            }

            this.drawOverlay(width, height, imgWidth, imgHeight);
            this.drawGraph();
            this.updateSliderStatus();
        } else if (compareIdx >= 0) {
            const prevEntry = this.frameBuffer[compareIdx];
            this.computeOpticalFlow(prevEntry.gray, gray, imgWidth, imgHeight, skipFrames);
            
            gray.delete();

            this.resultCache.set(frame, {
                flowData: this.lastFlowData ? {...this.lastFlowData, vectors: [...this.lastFlowData.vectors]} : null,
                smoothedDirection: {...this.smoothedDirection},
                angleHistory: [...this.angleHistory],
                imgWidth,
                imgHeight,
            });

            this.drawOverlay(width, height, imgWidth, imgHeight);
            this.drawGraph();
            this.updateSliderStatus();
        } else {
            gray.delete();
            
            this.resultCache.set(frame, {
                flowData: null,
                smoothedDirection: {...this.smoothedDirection},
                angleHistory: [...this.angleHistory],
                imgWidth,
                imgHeight,
            });
            
            this.drawOverlay(width, height, imgWidth, imgHeight);
            this.drawGraph();
            this.updateSliderStatus();
        }
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

    isPointMasked(x, y) {
        if (!this.maskEnabled || !this.maskOverlayNode) return false;
        return this.maskOverlayNode.isPointMasked(x, y);
    }

    computeOpticalFlowLinearTracklet(frame, imgWidth, imgHeight, skipFrames) {
        const result = this.computeLinearTracklet(frame, imgWidth, imgHeight, skipFrames);
        
        if (!result) {
            console.log(`Motion: technique=Linear Tracklet, result is null`);
            this.lastFlowData = {vectors: [], consensus: null, isGoodFrame: false};
            return;
        }
        
        const {flowVectors, consensus, lastSegmentConsensus} = result;
        if (!consensus) {
            console.log(`Motion: technique=Linear Tracklet, consensus is null, vectors=${flowVectors.length}`);
        }
        
        const isGoodFrame = this.isGoodQualityFrame(flowVectors, consensus);
        
        if (consensus && isGoodFrame) {
            if (this.smoothedDirection.confidence < 0.01) {
                this.smoothedDirection.x = consensus.dx;
                this.smoothedDirection.y = consensus.dy;
                this.smoothedDirection.magnitude = Math.sqrt(consensus.dx * consensus.dx + consensus.dy * consensus.dy);
                this.smoothedDirection.angle = Math.atan2(consensus.dy, consensus.dx);
                this.smoothedDirection.confidence = consensus.confidence;
                this.smoothedDirection.rotation = consensus.rotation || 0;
            } else {
                const baseAlpha = this.params.smoothingAlpha;
                const consensusMag = Math.sqrt(consensus.dx * consensus.dx + consensus.dy * consensus.dy);
                const prevMag = this.smoothedDirection.magnitude;
                const magRatio = prevMag > 0.01 ? consensusMag / prevMag : 1;
                const alpha = magRatio < 0.5 ? baseAlpha * 0.5 : baseAlpha;
                this.smoothedDirection.x = alpha * this.smoothedDirection.x + (1 - alpha) * consensus.dx;
                this.smoothedDirection.y = alpha * this.smoothedDirection.y + (1 - alpha) * consensus.dy;
                this.smoothedDirection.magnitude = Math.sqrt(
                    this.smoothedDirection.x * this.smoothedDirection.x + 
                    this.smoothedDirection.y * this.smoothedDirection.y
                );
                this.smoothedDirection.angle = Math.atan2(this.smoothedDirection.y, this.smoothedDirection.x);
                this.smoothedDirection.confidence = alpha * this.smoothedDirection.confidence + (1 - alpha) * consensus.confidence;
                this.smoothedDirection.rotation = consensus.rotation || 0;
            }
            if (Globals.regression) console.log(`Motion: technique=Linear Tracklet, consensus=(${consensus.dx.toFixed(2)}, ${consensus.dy.toFixed(2)}), smoothed=(${this.smoothedDirection.x.toFixed(2)}, ${this.smoothedDirection.y.toFixed(2)}), mag=${this.smoothedDirection.magnitude.toFixed(2)}, conf=${this.smoothedDirection.confidence.toFixed(2)}`);
            
            this.angleHistory.push({
                angle: this.smoothedDirection.angle,
                confidence: this.smoothedDirection.confidence
            });
            if (this.angleHistory.length > this.maxHistoryLength) {
                this.angleHistory.shift();
            }
        } else if (!isGoodFrame) {
            console.log(`Motion: BAD FRAME skipped - vectors=${flowVectors.length}, confidence=${consensus?.confidence?.toFixed(2) ?? 'null'}`);
        }

        this.lastFlowData = {vectors: flowVectors, consensus, lastSegmentConsensus, isGoodFrame};
    }

    computeOpticalFlow(prevGray, gray, imgWidth, imgHeight, skipFrames = 1) {
        let result;
        
        switch (this.params.technique) {
            case MOTION_TECHNIQUES.PHASE_CORRELATION:
                result = this.computePhaseCorrelation(prevGray, gray, imgWidth, imgHeight, skipFrames);
                break;
            case MOTION_TECHNIQUES.ECC_EUCLIDEAN:
                result = this.computeECC(prevGray, gray, imgWidth, imgHeight, skipFrames);
                break;
            case MOTION_TECHNIQUES.AFFINE_RANSAC:
                result = this.computeAffineRANSAC(prevGray, gray, imgWidth, imgHeight, skipFrames);
                break;
            case MOTION_TECHNIQUES.SPARSE_CONSENSUS:
            default:
                result = this.computeSparseConsensus(prevGray, gray, imgWidth, imgHeight, skipFrames);
                break;
        }
        
        if (!result) {
            console.log(`Motion: technique=${this.params.technique}, result is null`);
            this.lastFlowData = {vectors: [], consensus: null, isGoodFrame: false};
            return;
        }
        
        const {flowVectors, consensus} = result;
        if (!consensus) {
            console.log(`Motion: technique=${this.params.technique}, consensus is null, vectors=${flowVectors.length}`);
        }
        
        const isGoodFrame = this.isGoodQualityFrame(flowVectors, consensus);
        
        if (consensus && isGoodFrame) {
            if (this.smoothedDirection.confidence < 0.01) {
                this.smoothedDirection.x = consensus.dx;
                this.smoothedDirection.y = consensus.dy;
                this.smoothedDirection.magnitude = Math.sqrt(consensus.dx * consensus.dx + consensus.dy * consensus.dy);
                this.smoothedDirection.angle = Math.atan2(consensus.dy, consensus.dx);
                this.smoothedDirection.confidence = consensus.confidence;
                this.smoothedDirection.rotation = consensus.rotation || 0;
            } else {
                const baseAlpha = this.params.smoothingAlpha;
                const consensusMag = Math.sqrt(consensus.dx * consensus.dx + consensus.dy * consensus.dy);
                const prevMag = this.smoothedDirection.magnitude;
                const magRatio = prevMag > 0.01 ? consensusMag / prevMag : 1;
                const alpha = magRatio < 0.5 ? baseAlpha * 0.5 : baseAlpha;
                this.smoothedDirection.x = alpha * this.smoothedDirection.x + (1 - alpha) * consensus.dx;
                this.smoothedDirection.y = alpha * this.smoothedDirection.y + (1 - alpha) * consensus.dy;
                this.smoothedDirection.magnitude = Math.sqrt(
                    this.smoothedDirection.x * this.smoothedDirection.x + 
                    this.smoothedDirection.y * this.smoothedDirection.y
                );
                this.smoothedDirection.angle = Math.atan2(this.smoothedDirection.y, this.smoothedDirection.x);
                this.smoothedDirection.confidence = alpha * this.smoothedDirection.confidence + (1 - alpha) * consensus.confidence;
                this.smoothedDirection.rotation = consensus.rotation || 0;
            }
            if (Globals.regression) console.log(`Motion: technique=${this.params.technique}, consensus=(${consensus.dx.toFixed(2)}, ${consensus.dy.toFixed(2)}), smoothed=(${this.smoothedDirection.x.toFixed(2)}, ${this.smoothedDirection.y.toFixed(2)}), mag=${this.smoothedDirection.magnitude.toFixed(2)}, conf=${this.smoothedDirection.confidence.toFixed(2)}`);
            
            this.angleHistory.push({
                angle: this.smoothedDirection.angle,
                confidence: this.smoothedDirection.confidence
            });
            if (this.angleHistory.length > this.maxHistoryLength) {
                this.angleHistory.shift();
            }
        } else if (!isGoodFrame) {
            console.log(`Motion: BAD FRAME skipped - vectors=${flowVectors.length}, confidence=${consensus?.confidence?.toFixed(2) ?? 'null'}`);
        }

        this.lastFlowData = {vectors: flowVectors, consensus, isGoodFrame};
    }

    computePhaseCorrelation(prevGray, gray, imgWidth, imgHeight, skipFrames) {
        if (typeof cv.phaseCorrelate !== 'function') {
            if (!this._phaseCorrelateWarned) {
                console.warn("cv.phaseCorrelate not in this opencv.js build, using DFT-based implementation");
                this._phaseCorrelateWarned = true;
            }
            return this.computePhaseCorrelationDFT(prevGray, gray, imgWidth, imgHeight, skipFrames);
        }
        
        const motionScale = 1 / skipFrames;
        const prevFloat = new cv.Mat();
        const grayFloat = new cv.Mat();
        prevGray.convertTo(prevFloat, cv.CV_32F);
        gray.convertTo(grayFloat, cv.CV_32F);
        
        let shift, response = 0.5;
        try {
            shift = cv.phaseCorrelate(prevFloat, grayFloat);
            if (shift.response !== undefined) {
                response = shift.response;
            }
        } catch (e) {
            console.error("Phase correlation error:", e);
            prevFloat.delete();
            grayFloat.delete();
            return null;
        }
        
        prevFloat.delete();
        grayFloat.delete();
        
        const dx = shift.x * motionScale;
        const dy = shift.y * motionScale;
        const mag = Math.sqrt(dx * dx + dy * dy);
        const confidence = Math.min(1, Math.max(0.5, response));
        
        const flowVectors = (mag >= this.params.minMotion && mag <= this.params.maxMotion)
            ? this.generateSyntheticVectors(dx, dy, 0, imgWidth, imgHeight)
            : [];
        
        return {
            flowVectors,
            consensus: {dx, dy, confidence, rotation: 0, inlierCount: flowVectors.length}
        };
    }

    computePhaseCorrelationDFT(prevGray, gray, imgWidth, imgHeight, skipFrames) {
        const motionScale = 1 / skipFrames;
        
        const optW = cv.getOptimalDFTSize(imgWidth);
        const optH = cv.getOptimalDFTSize(imgHeight);
        
        const padded1 = new cv.Mat();
        const padded2 = new cv.Mat();
        cv.copyMakeBorder(prevGray, padded1, 0, optH - imgHeight, 0, optW - imgWidth, cv.BORDER_CONSTANT, new cv.Scalar(0));
        cv.copyMakeBorder(gray, padded2, 0, optH - imgHeight, 0, optW - imgWidth, cv.BORDER_CONSTANT, new cv.Scalar(0));
        
        const float1 = new cv.Mat();
        const float2 = new cv.Mat();
        padded1.convertTo(float1, cv.CV_32F);
        padded2.convertTo(float2, cv.CV_32F);
        padded1.delete();
        padded2.delete();
        
        const planes1 = new cv.MatVector();
        const planes2 = new cv.MatVector();
        const zeros1 = cv.Mat.zeros(optH, optW, cv.CV_32F);
        const zeros2 = cv.Mat.zeros(optH, optW, cv.CV_32F);
        planes1.push_back(float1);
        planes1.push_back(zeros1);
        planes2.push_back(float2);
        planes2.push_back(zeros2);
        
        const complex1 = new cv.Mat();
        const complex2 = new cv.Mat();
        cv.merge(planes1, complex1);
        cv.merge(planes2, complex2);
        float1.delete();
        float2.delete();
        zeros1.delete();
        zeros2.delete();
        planes1.delete();
        planes2.delete();
        
        cv.dft(complex1, complex1);
        cv.dft(complex2, complex2);
        
        const split1 = new cv.MatVector();
        const split2 = new cv.MatVector();
        cv.split(complex1, split1);
        cv.split(complex2, split2);
        const re1 = split1.get(0);
        const im1 = split1.get(1);
        const re2 = split2.get(0);
        const im2 = split2.get(1);
        
        const crossRe = new cv.Mat();
        const crossIm = new cv.Mat();
        const temp1 = new cv.Mat();
        const temp2 = new cv.Mat();
        cv.multiply(re1, re2, temp1);
        cv.multiply(im1, im2, temp2);
        cv.add(temp1, temp2, crossRe);
        cv.multiply(im1, re2, temp1);
        cv.multiply(re1, im2, temp2);
        cv.subtract(temp1, temp2, crossIm);
        temp1.delete();
        temp2.delete();
        split1.delete();
        split2.delete();
        complex1.delete();
        complex2.delete();
        
        const mag = new cv.Mat();
        cv.magnitude(crossRe, crossIm, mag);
        const epsilon = cv.Mat.ones(optH, optW, cv.CV_32F);
        for (let i = 0; i < epsilon.rows * epsilon.cols; i++) {
            epsilon.data32F[i] = 1e-10;
        }
        cv.add(mag, epsilon, mag);
        epsilon.delete();
        
        cv.divide(crossRe, mag, crossRe);
        cv.divide(crossIm, mag, crossIm);
        mag.delete();
        
        const normPlanes = new cv.MatVector();
        normPlanes.push_back(crossRe);
        normPlanes.push_back(crossIm);
        const normCross = new cv.Mat();
        cv.merge(normPlanes, normCross);
        crossRe.delete();
        crossIm.delete();
        normPlanes.delete();
        
        const invResult = new cv.Mat();
        cv.dft(normCross, invResult, cv.DFT_INVERSE | cv.DFT_SCALE);
        normCross.delete();
        
        const resultPlanes = new cv.MatVector();
        cv.split(invResult, resultPlanes);
        const result = resultPlanes.get(0);
        invResult.delete();
        resultPlanes.delete();
        
        const minMax = cv.minMaxLoc(result);
        const peakLoc = minMax.maxLoc;
        const response = minMax.maxVal;
        result.delete();
        
        let shiftX = peakLoc.x;
        let shiftY = peakLoc.y;
        if (shiftX > optW / 2) shiftX -= optW;
        if (shiftY > optH / 2) shiftY -= optH;
        
        let dx = -shiftX * motionScale;
        let dy = -shiftY * motionScale;
        const motionMag = Math.sqrt(dx * dx + dy * dy);
        
        if (motionMag < this.params.minMotion && response < 0.5) {
            if (!this._phaseCorrelationFallbackWarned) {
                console.warn("Phase Correlation detected no significant translation (response=" + response.toFixed(2) + "), falling back to Sparse + Consensus");
                this._phaseCorrelationFallbackWarned = true;
            }
            return this.computeSparseConsensus(prevGray, gray, imgWidth, imgHeight, skipFrames);
        }
        
        const confidence = Math.min(1, Math.max(0.3, response * 10));
        
        const flowVectors = (motionMag >= this.params.minMotion && motionMag <= this.params.maxMotion)
            ? this.generateSyntheticVectors(dx, dy, 0, imgWidth, imgHeight)
            : [];
        
        return {
            flowVectors,
            consensus: {dx, dy, confidence, rotation: 0, inlierCount: flowVectors.length}
        };
    }

    computeECC(prevGray, gray, imgWidth, imgHeight, skipFrames) {
        if (typeof cv.findTransformECC !== 'function') {
            if (!this._eccWarned) {
                console.warn("cv.findTransformECC not available, falling back to Affine RANSAC");
                this._eccWarned = true;
            }
            return this.computeAffineRANSAC(prevGray, gray, imgWidth, imgHeight, skipFrames);
        }
        
        const motionScale = 1 / skipFrames;
        const warpMatrix = cv.Mat.eye(2, 3, cv.CV_32F);
        
        const criteria = new cv.TermCriteria(
            cv.TermCriteria_COUNT + cv.TermCriteria_EPS,
            this.params.eccIterations,
            this.params.eccEpsilon
        );
        
        const inputMask = new cv.Mat();
        const gaussFiltSize = 5;
        
        let cc;
        try {
            cc = cv.findTransformECC(prevGray, gray, warpMatrix, cv.MOTION_EUCLIDEAN, criteria, inputMask, gaussFiltSize);
        } catch (e) {
            console.error("ECC error:", e.message || e);
            warpMatrix.delete();
            inputMask.delete();
            return null;
        }
        
        inputMask.delete();
        
        const cosTheta = warpMatrix.floatAt(0, 0);
        const sinTheta = warpMatrix.floatAt(1, 0);
        const txRaw = warpMatrix.floatAt(0, 2);
        const tyRaw = warpMatrix.floatAt(1, 2);
        warpMatrix.delete();
        
        const rotationRaw = Math.atan2(sinTheta, cosTheta);
        const rotation = rotationRaw * motionScale;
        const dx = txRaw * motionScale;
        const dy = tyRaw * motionScale;
        const mag = Math.sqrt(dx * dx + dy * dy);
        const confidence = Math.min(1, cc);
        
        const showVectors = mag >= this.params.minMotion || Math.abs(rotation) >= 0.0003;
        const flowVectors = showVectors
            ? this.generateSyntheticVectors(dx, dy, rotation, imgWidth, imgHeight)
            : [];
        
        return {
            flowVectors,
            consensus: {dx, dy, confidence, rotation, inlierCount: flowVectors.length}
        };
    }

    computeAffineRANSAC(prevGray, gray, imgWidth, imgHeight, skipFrames) {
        if (typeof cv.estimateAffine2D !== 'function') {
            if (!this._affineWarned) {
                console.warn("cv.estimateAffine2D not available, falling back to Sparse + Consensus");
                this._affineWarned = true;
            }
            return this.computeSparseConsensus(prevGray, gray, imgWidth, imgHeight, skipFrames);
        }
        
        const {prevPoints, nextPoints, qualities} = this.trackFeatures(prevGray, gray, skipFrames);
        
        if (prevPoints.length < 4) {
            return {flowVectors: [], consensus: null};
        }
        
        const prevPtsMat = cv.matFromArray(prevPoints.length, 1, cv.CV_32FC2, prevPoints.flat());
        const nextPtsMat = cv.matFromArray(nextPoints.length, 1, cv.CV_32FC2, nextPoints.flat());
        const inliersMask = new cv.Mat();
        
        let transform;
        try {
            // NOTE: this opencv-js build does not ship estimateAffinePartial2D, so this
            // technique used to throw here and silently fall back to sparse consensus.
            // estimateAffine2D (full 6-DOF affine + RANSAC) is available and returns the
            // same 2x3 matrix layout; rotation/translation are read identically below.
            transform = cv.estimateAffine2D(prevPtsMat, nextPtsMat, inliersMask, cv.RANSAC, this.params.ransacThreshold);
        } catch (e) {
            prevPtsMat.delete();
            nextPtsMat.delete();
            inliersMask.delete();
            return null;
        }
        
        if (!transform || transform.empty()) {
            prevPtsMat.delete();
            nextPtsMat.delete();
            inliersMask.delete();
            if (transform) transform.delete();
            return null;
        }
        
        const motionScale = 1 / skipFrames;
        const cosTheta = transform.doubleAt(0, 0);
        const sinTheta = transform.doubleAt(1, 0);
        const txRaw = transform.doubleAt(0, 2);
        const tyRaw = transform.doubleAt(1, 2);
        transform.delete();
        
        const rotation = Math.atan2(sinTheta, cosTheta);
        const dx = txRaw * motionScale;
        const dy = tyRaw * motionScale;
        
        const flowVectors = [];
        let inlierCount = 0;
        
        for (let i = 0; i < prevPoints.length; i++) {
            const isInlier = inliersMask.data[i] === 1;
            if (isInlier) inlierCount++;
            
            const [px, py] = prevPoints[i];
            const [nx, ny] = nextPoints[i];
            const vdx = (nx - px) * motionScale;
            const vdy = (ny - py) * motionScale;
            const mag = Math.sqrt(vdx * vdx + vdy * vdy);
            
            flowVectors.push({
                px, py, dx: vdx, dy: vdy, mag,
                quality: qualities[i],
                angle: Math.atan2(vdy, vdx),
                isInlier
            });
        }
        
        prevPtsMat.delete();
        nextPtsMat.delete();
        inliersMask.delete();
        
        const confidence = inlierCount / prevPoints.length;
        
        return {
            flowVectors,
            consensus: {dx, dy, confidence, rotation, inlierCount}
        };
    }

    getTrackletSourceFrames(frame, skipFrames) {
        if (!this.params.skipDuplicateFrames) {
            const startFrame = frame - skipFrames;
            if (startFrame < 0) return null;
            const frames = [];
            for (let f = startFrame; f <= frame; f++) frames.push(f);
            return frames;
        }

        const frames = [];
        for (let f = frame; f >= 0 && frames.length < skipFrames + 1; f--) {
            const duplicateInfo = this.duplicateFrameCache.get(f);
            if (duplicateInfo?.isDuplicate) continue;
            frames.push(f);
        }
        if (frames.length < skipFrames + 1) return null;
        return frames.reverse();
    }

    computeLinearTracklet(frame, imgWidth, imgHeight, skipFrames, beforeFrameCallback = null) {
        const videoData = this.videoView.videoData;
        if (!videoData) return {flowVectors: [], consensus: null};
        
        const sourceFrames = this.getTrackletSourceFrames(frame, skipFrames);
        if (!sourceFrames) return {flowVectors: [], consensus: null};
        
        const grayFrames = [];
        for (const f of sourceFrames) {
            const entry = this.frameBuffer.find(e => e.frame === f);
            if (entry) {
                grayFrames.push(entry.gray);
            } else {
                beforeFrameCallback?.(f);
                const image = videoData.getImage(f);
                if (!image || !image.width || !image.height) {
                    for (const g of grayFrames) {
                        if (!this.frameBuffer.some(e => e.gray === g)) g.delete();
                    }
                    return {flowVectors: [], consensus: null};
                }
                const {gray} = imageToGrayscale(image, this.params.blurSize);
                grayFrames.push(gray);
            }
        }
        
        if (grayFrames.length < 2) {
            return {flowVectors: [], consensus: null};
        }
        
        const firstGray = grayFrames[0];
        const corners = new cv.Mat();
        try {
            cv.goodFeaturesToTrack(firstGray, corners, this.params.maxFeatures, this.params.qualityLevel, this.params.minDistance);
        } catch (e) {
            corners.delete();
            return {flowVectors: [], consensus: null};
        }
        
        if (corners.rows === 0) {
            corners.delete();
            return {flowVectors: [], consensus: null};
        }
        
        try {
            const winSize = new cv.Size(5, 5);
            const zeroZone = new cv.Size(-1, -1);
            const criteria = new cv.TermCriteria(cv.TermCriteria_EPS + cv.TermCriteria_COUNT, 30, 0.01);
            cv.cornerSubPix(firstGray, corners, winSize, zeroZone, criteria);
        } catch (e) {
        }
        
        const trajectories = [];
        for (let i = 0; i < corners.rows; i++) {
            const px = corners.floatAt(i, 0);
            const py = corners.floatAt(i, 1);
            if (this.isPointMasked(px, py)) continue;
            trajectories.push({points: [[px, py]], valid: true, errors: []});
        }
        corners.delete();
        
        let currentPoints = new cv.Mat(trajectories.length, 1, cv.CV_32FC2);
        for (let i = 0; i < trajectories.length; i++) {
            currentPoints.floatPtr(i, 0)[0] = trajectories[i].points[0][0];
            currentPoints.floatPtr(i, 0)[1] = trajectories[i].points[0][1];
        }
        
        for (let step = 0; step < grayFrames.length - 1; step++) {
            const prevGray = grayFrames[step];
            const nextGray = grayFrames[step + 1];
            
            const nextPtsMat = new cv.Mat();
            const status = new cv.Mat();
            const err = new cv.Mat();
            
            try {
                cv.calcOpticalFlowPyrLK(prevGray, nextGray, currentPoints, nextPtsMat, status, err);
            } catch (e) {
                nextPtsMat.delete();
                status.delete();
                err.delete();
                break;
            }
            
            let validIdx = 0;
            for (let i = 0; i < trajectories.length; i++) {
                if (!trajectories[i].valid) continue;
                if (status.data[validIdx] !== 1) {
                    trajectories[i].valid = false;
                } else {
                    const nx = nextPtsMat.floatAt(validIdx, 0);
                    const ny = nextPtsMat.floatAt(validIdx, 1);
                    const trackError = err.floatAt(validIdx, 0);
                    trajectories[i].points.push([nx, ny]);
                    trajectories[i].errors.push(trackError);
                    if (trackError > this.params.maxTrackError) {
                        trajectories[i].valid = false;
                    }
                }
                validIdx++;
            }
            
            const validTrajectories = trajectories.filter(t => t.valid);
            if (validTrajectories.length === 0) {
                nextPtsMat.delete();
                status.delete();
                err.delete();
                break;
            }
            
            currentPoints.delete();
            currentPoints = new cv.Mat(validTrajectories.length, 1, cv.CV_32FC2);
            let idx = 0;
            for (const t of trajectories) {
                if (t.valid) {
                    const lastPt = t.points[t.points.length - 1];
                    currentPoints.floatPtr(idx, 0)[0] = lastPt[0];
                    currentPoints.floatPtr(idx, 0)[1] = lastPt[1];
                    idx++;
                }
            }
            
            nextPtsMat.delete();
            status.delete();
            err.delete();
        }
        
        currentPoints.delete();
        
        for (let i = 0; i < grayFrames.length; i++) {
            if (!this.frameBuffer.some(e => e.gray === grayFrames[i])) {
                grayFrames[i].delete();
            }
        }
        
        const flowVectors = [];
        const lastSegmentFlowVectors = [];
        const motionScale = 1 / skipFrames;
        
        for (const traj of trajectories) {
            if (!traj.valid || traj.points.length < skipFrames + 1) continue;
            
            const start = traj.points[0];
            const end = traj.points[traj.points.length - 1];
            const totalDx = end[0] - start[0];
            const totalDy = end[1] - start[1];
            const totalDist = Math.sqrt(totalDx * totalDx + totalDy * totalDy);
            
            if (totalDist < 0.001) continue;
            
            const expectedStepDx = totalDx / skipFrames;
            const expectedStepDy = totalDy / skipFrames;
            const expectedStepMag = totalDist / skipFrames;
            
            let maxDeviation = 0;
            let maxSpacingError = 0;
            
            for (let i = 1; i < traj.points.length; i++) {
                const actualDx = traj.points[i][0] - traj.points[i-1][0];
                const actualDy = traj.points[i][1] - traj.points[i-1][1];
                const actualMag = Math.sqrt(actualDx * actualDx + actualDy * actualDy);
                
                const expectedX = start[0] + expectedStepDx * i;
                const expectedY = start[1] + expectedStepDy * i;
                const deviationX = traj.points[i][0] - expectedX;
                const deviationY = traj.points[i][1] - expectedY;
                const deviation = Math.sqrt(deviationX * deviationX + deviationY * deviationY);
                maxDeviation = Math.max(maxDeviation, deviation);
                
                if (expectedStepMag > 0.1) {
                    const spacingError = Math.abs(actualMag - expectedStepMag) / expectedStepMag;
                    maxSpacingError = Math.max(maxSpacingError, spacingError);
                }
            }
            
            const linearityScore = totalDist > 0 ? Math.max(0, 1 - maxDeviation / totalDist) : 0;
            const spacingScore = Math.max(0, 1 - maxSpacingError);
            
            const adaptedLinearityThreshold = totalDist < 1.0 
                ? this.params.linearityThreshold * 0.6 
                : this.params.linearityThreshold;
            const adaptedSpacingThreshold = totalDist < 1.0 
                ? this.params.spacingThreshold * 0.6 
                : this.params.spacingThreshold;
            
            if (linearityScore < adaptedLinearityThreshold) continue;
            if (spacingScore < adaptedSpacingThreshold) continue;
            
            const dx = totalDx * motionScale;
            const dy = totalDy * motionScale;
            const mag = Math.sqrt(dx * dx + dy * dy);
            const penultimate = traj.points[traj.points.length - 2];
            const lastDx = end[0] - penultimate[0];
            const lastDy = end[1] - penultimate[1];
            const lastMag = Math.sqrt(lastDx * lastDx + lastDy * lastDy);
            
            const key = `${Math.round(start[0] / 20)}_${Math.round(start[1] / 20)}`;
            let staticScore = this.staticHistory.get(key) || 0;
            if (mag < this.params.staticThreshold) {
                staticScore = Math.min(staticScore + 1, this.params.staticFrames);
            } else {
                staticScore = Math.max(staticScore - 2, 0);
            }
            this.staticHistory.set(key, staticScore);
            
            const isStatic = staticScore >= this.params.staticFrames * 0.7;
            if (isStatic) continue;
            if (mag > this.params.maxMotion) continue;
            const noiseFloor = 0.02;
            if (mag < noiseFloor) continue;
            
            const avgError = traj.errors.length > 0 ? traj.errors.reduce((a, b) => a + b, 0) / traj.errors.length : 0;
            const belowMinMotion = mag < this.params.minMotion;
            const slowMotionPenalty = belowMinMotion ? 0.7 : 1.0;
            const quality = Math.max(0, 1 - avgError / this.params.maxTrackError) * linearityScore * spacingScore * slowMotionPenalty;
            
            if (quality < this.params.minQuality) continue;
            
            flowVectors.push({
                px: start[0], py: start[1], dx, dy, mag,
                quality,
                angle: Math.atan2(dy, dx),
                trackError: avgError,
                linearityScore,
                spacingScore
            });
            lastSegmentFlowVectors.push({
                px: penultimate[0], py: penultimate[1], dx: lastDx, dy: lastDy, mag: lastMag,
                quality,
                angle: Math.atan2(lastDy, lastDx),
                trackError: avgError,
                linearityScore,
                spacingScore
            });
        }
        
        if (flowVectors.length < 3) {
            return {flowVectors: [], consensus: null};
        }
        
        const consensus = this.findConsensus(flowVectors);
        const lastSegmentConsensus = this.findConsensus(lastSegmentFlowVectors);
        return {flowVectors, consensus, lastSegmentConsensus};
    }

    computeSparseConsensus(prevGray, gray, imgWidth, imgHeight, skipFrames) {
        const {prevPoints, nextPoints, qualities, trackErrors} = this.trackFeatures(prevGray, gray, skipFrames);
        
        const flowVectors = [];
        const motionScale = 1 / skipFrames;
        
        for (let i = 0; i < prevPoints.length; i++) {
            const [px, py] = prevPoints[i];
            const [nx, ny] = nextPoints[i];
            const dx = (nx - px) * motionScale;
            const dy = (ny - py) * motionScale;
            const mag = Math.sqrt(dx * dx + dy * dy);
            
            const key = `${Math.round(px / 20)}_${Math.round(py / 20)}`;
            let staticScore = this.staticHistory.get(key) || 0;
            
            if (mag < this.params.staticThreshold) {
                staticScore = Math.min(staticScore + 1, this.params.staticFrames);
            } else {
                staticScore = Math.max(staticScore - 2, 0);
            }
            this.staticHistory.set(key, staticScore);
            
            const isStatic = staticScore >= this.params.staticFrames * 0.7;
            if (isStatic) continue;
            if (mag > this.params.maxMotion) continue;
            const noiseFloor = 0.02;
            if (mag < noiseFloor) continue;
            const belowMinMotion = mag < this.params.minMotion;
            const slowMotionPenalty = belowMinMotion ? 0.7 : 1.0;
            const adjustedQuality = qualities[i] * slowMotionPenalty;
            if (adjustedQuality < this.params.minQuality) continue;
            
            flowVectors.push({
                px, py, dx, dy, mag,
                quality: adjustedQuality,
                angle: Math.atan2(dy, dx),
                trackError: trackErrors[i]
            });
        }
        
        if (flowVectors.length < 3) {
            return {flowVectors: [], consensus: null};
        }
        
        const consensus = this.findConsensus(flowVectors);
        return {flowVectors, consensus};
    }

    trackFeatures(prevGray, gray, skipFrames) {
        const prevPoints = [];
        const nextPoints = [];
        const qualities = [];
        const trackErrors = [];
        
        const corners = new cv.Mat();
        try {
            cv.goodFeaturesToTrack(prevGray, corners, this.params.maxFeatures, this.params.qualityLevel, this.params.minDistance);
        } catch (e) {
            corners.delete();
            return {prevPoints, nextPoints, qualities, trackErrors};
        }
        
        if (corners.rows === 0) {
            corners.delete();
            return {prevPoints, nextPoints, qualities, trackErrors};
        }
        
        const nextPtsMat = new cv.Mat();
        const status = new cv.Mat();
        const err = new cv.Mat();
        
        try {
            cv.calcOpticalFlowPyrLK(prevGray, gray, corners, nextPtsMat, status, err);
        } catch (e) {
            corners.delete();
            nextPtsMat.delete();
            status.delete();
            err.delete();
            return {prevPoints, nextPoints, qualities, trackErrors};
        }
        
        const motionScale = 1 / skipFrames;
        
        for (let i = 0; i < status.rows; i++) {
            if (status.data[i] !== 1) continue;
            
            const px = corners.floatAt(i, 0);
            const py = corners.floatAt(i, 1);
            
            if (this.isPointMasked(px, py)) continue;
            
            const nx = nextPtsMat.floatAt(i, 0);
            const ny = nextPtsMat.floatAt(i, 1);
            const trackError = err.floatAt(i, 0);
            
            if (trackError > this.params.maxTrackError) continue;
            
            const dx = (nx - px) * motionScale;
            const dy = (ny - py) * motionScale;
            const mag = Math.sqrt(dx * dx + dy * dy);
            
            const errorQuality = Math.max(0, 1 - trackError / this.params.maxTrackError);
            const magQuality = Math.min(1, mag / 1.0);
            const quality = errorQuality * magQuality;
            
            prevPoints.push([px, py]);
            nextPoints.push([nx, ny]);
            qualities.push(quality);
            trackErrors.push(trackError);
        }
        
        corners.delete();
        nextPtsMat.delete();
        status.delete();
        err.delete();
        
        return {prevPoints, nextPoints, qualities, trackErrors};
    }

    generateSyntheticVectors(dx, dy, rotation, imgWidth, imgHeight) {
        const vectors = [];
        const cx = imgWidth / 2;
        const cy = imgHeight / 2;
        const gridSize = 8;
        const mag = Math.sqrt(dx * dx + dy * dy);
        const angle = Math.atan2(dy, dx);
        
        for (let gx = 0; gx < gridSize; gx++) {
            for (let gy = 0; gy < gridSize; gy++) {
                const px = (gx + 0.5) * imgWidth / gridSize;
                const py = (gy + 0.5) * imgHeight / gridSize;
                
                if (this.isPointMasked(px, py)) continue;
                
                const rx = px - cx;
                const ry = py - cy;
                const vdx = dx - rotation * ry;
                const vdy = dy + rotation * rx;
                const vmag = Math.sqrt(vdx * vdx + vdy * vdy);
                
                vectors.push({
                    px, py, dx: vdx, dy: vdy,
                    mag: vmag,
                    quality: 1.0,
                    angle: Math.atan2(vdy, vdx),
                    isInlier: true
                });
            }
        }
        return vectors;
    }

    // Choose how "background" is defined for a set of flow vectors. With
    // rejectMovingObjects on, fit a global affine background and drop independent
    // movers; otherwise use the legacy direction-agreement consensus. Falls back to
    // the direction consensus whenever the global fit can't find a dominant background.
    findConsensus(vectors) {
        if (this.params.rejectMovingObjects) {
            const global = this.findConsensusGlobalModel(vectors);
            if (global) return global;
        }
        return this.findConsensusDirection(vectors);
    }

    findConsensusDirection(vectors) {
        if (vectors.length < 3) return null;

        const numBins = 36;
        const binSize = (2 * Math.PI) / numBins;
        const bins = new Array(numBins).fill(null).map(() => []);
        
        for (const v of vectors) {
            let angle = v.angle;
            if (angle < 0) angle += 2 * Math.PI;
            const bin = Math.floor(angle / binSize) % numBins;
            bins[bin].push(v);
        }

        let bestBin = -1;
        let bestScore = 0;
        
        for (let i = 0; i < numBins; i++) {
            const neighbors = [
                bins[(i - 1 + numBins) % numBins],
                bins[i],
                bins[(i + 1) % numBins]
            ].flat();
            
            const score = neighbors.reduce((sum, v) => sum + v.quality * Math.max(v.mag, 0.1), 0);
            if (score > bestScore) {
                bestScore = score;
                bestBin = i;
            }
        }

        if (bestBin < 0) return null;

        const inliers = [
            bins[(bestBin - 1 + numBins) % numBins],
            bins[bestBin],
            bins[(bestBin + 1) % numBins]
        ].flat();

        if (inliers.length < 2) return null;

        let sumDx = 0, sumDy = 0, sumWeight = 0;
        for (const v of inliers) {
            const weight = v.quality;
            sumDx += v.dx * weight;
            sumDy += v.dy * weight;
            sumWeight += weight;
        }

        if (sumWeight < 0.01) return null;

        const dx = sumDx / sumWeight;
        const dy = sumDy / sumWeight;
        const inlierRatio = inliers.length / vectors.length;
        const avgQuality = sumWeight / inliers.length;
        const confidence = Math.min(1, inlierRatio + 0.2) * Math.min(1, avgQuality + 0.3);

        for (const v of vectors) {
            const consensusMag = Math.sqrt(dx*dx + dy*dy);
            const dotProduct = consensusMag > 0.001 
                ? (v.dx * dx + v.dy * dy) / (v.mag * consensusMag + 0.001)
                : 1;
            v.isInlier = dotProduct > this.params.inlierThreshold;
        }

        return {dx, dy, confidence, inlierCount: inliers.length};
    }

    // Background-only consensus that rejects independently-moving objects.
    //
    // findConsensusDirection() classifies vectors by DIRECTION agreement alone, so
    // traffic moving parallel to the background (same angle, different speed) leaks in
    // as "background" and corrupts the estimate. Here we instead fit a single global
    // AFFINE transform (translation + rotation + scale + shear) to the background and
    // keep a vector only if it agrees with that one rigid model within
    // objectRejectThreshold pixels. Any car, truck, or other independent mover —
    // regardless of its direction or speed — produces a large residual and is rejected.
    //
    // We do NOT use cv RANSAC here: it is randomized, so near-identical frames land on
    // different inlier sets and the overlay FLICKERS red<->green; worse, on a frame
    // with sparse background features it can lock onto the tracked object's tight
    // near-zero-motion cluster and flag the OBJECT as background. Instead we run a
    // deterministic iteratively-reweighted least-squares (IRLS) fit, SEEDED from the
    // dominant-direction majority (reliably the background, because background vectors
    // carry more magnitude than the camera-followed, near-stationary target). Seeding
    // from the background and never sampling randomly makes the result temporally
    // stable and immune to the "target turns green" mode-flip.
    //
    // Returns the same {dx, dy, confidence, rotation, inlierCount} shape as
    // findConsensusDirection and sets v.isInlier on every vector; returns null (caller
    // falls back to the direction consensus) when there is no usable rigid background.
    findConsensusGlobalModel(vectors) {
        if (vectors.length < 6) return null;

        // Seed inliers from the dominant-direction majority (sets v.isInlier). This is
        // the background, since the followed target contributes little magnitude.
        const seed = this.findConsensusDirection(vectors);
        if (!seed) return null;

        const thr = this.params.objectRejectThreshold;
        const thr2 = thr * thr;
        let inlier = vectors.map(v => v.isInlier);
        let affine = null;

        // IRLS: fit affine to current inliers, then reclassify everything by residual
        // against that affine. Converges to the background in a few passes.
        for (let iter = 0; iter < 5; iter++) {
            const fit = this.fitAffineLeastSquares(vectors, inlier);
            if (!fit) break;
            affine = fit;
            const [a, b, c, d, e, f] = fit;
            let count = 0;
            let changed = false;
            const nextInlier = new Array(vectors.length);
            for (let i = 0; i < vectors.length; i++) {
                const v = vectors[i];
                const predX = a * v.px + b * v.py + c;
                const predY = d * v.px + e * v.py + f;
                const ex = predX - (v.px + v.dx);
                const ey = predY - (v.py + v.dy);
                const inl = (ex * ex + ey * ey) <= thr2;
                nextInlier[i] = inl;
                if (inl) count++;
                if (inl !== inlier[i]) changed = true;
            }
            if (count < 3) { affine = null; break; }
            inlier = nextInlier;
            if (!changed) break;   // converged
        }

        if (!affine) return null;

        // Background translation = quality-weighted mean of inlier displacements
        // (same semantics as the direction-consensus path, restricted to background).
        let sumDx = 0, sumDy = 0, sumWeight = 0, inlierCount = 0;
        for (let i = 0; i < vectors.length; i++) {
            vectors[i].isInlier = inlier[i];
            if (inlier[i]) {
                const w = vectors[i].quality;
                sumDx += vectors[i].dx * w;
                sumDy += vectors[i].dy * w;
                sumWeight += w;
                inlierCount++;
            }
        }
        if (inlierCount < 3 || sumWeight < 0.01) return null;

        const dx = sumDx / sumWeight;
        const dy = sumDy / sumWeight;
        const rotation = Math.atan2(affine[3], affine[0]);   // d/a from the affine basis
        const inlierRatio = inlierCount / vectors.length;
        const avgQuality = sumWeight / inlierCount;
        const confidence = Math.min(1, inlierRatio + 0.2) * Math.min(1, avgQuality + 0.3);

        return {dx, dy, confidence, rotation, inlierCount};
    }

    // Quality-weighted least-squares affine fit over the flagged inliers. Solves
    // x' = a*x + b*y + c and y' = d*x + e*y + f via the 3x3 normal equations (both
    // share the same normal matrix). Returns [a,b,c,d,e,f] or null if degenerate
    // (too few or near-collinear points → singular matrix). Deterministic.
    fitAffineLeastSquares(vectors, inlier) {
        let Sxx = 0, Sxy = 0, Sx = 0, Syy = 0, Sy = 0, S1 = 0;
        let bx0 = 0, bx1 = 0, bx2 = 0;   // RHS for x'
        let by0 = 0, by1 = 0, by2 = 0;   // RHS for y'
        let n = 0;
        for (let i = 0; i < vectors.length; i++) {
            if (!inlier[i]) continue;
            const v = vectors[i];
            const w = v.quality > 0 ? v.quality : 1e-3;
            const x = v.px, y = v.py;
            const xp = v.px + v.dx, yp = v.py + v.dy;
            Sxx += w * x * x; Sxy += w * x * y; Sx += w * x;
            Syy += w * y * y; Sy += w * y; S1 += w;
            bx0 += w * x * xp; bx1 += w * y * xp; bx2 += w * xp;
            by0 += w * x * yp; by1 += w * y * yp; by2 += w * yp;
            n++;
        }
        if (n < 3) return null;

        // Invert the symmetric 3x3 normal matrix M = [[Sxx,Sxy,Sx],[Sxy,Syy,Sy],[Sx,Sy,S1]].
        const m00 = Sxx, m01 = Sxy, m02 = Sx;
        const m11 = Syy, m12 = Sy, m22 = S1;
        const c00 = m11 * m22 - m12 * m12;
        const c01 = m12 * m02 - m01 * m22;
        const c02 = m01 * m12 - m11 * m02;
        const det = m00 * c00 + m01 * c01 + m02 * c02;
        if (Math.abs(det) < 1e-9) return null;   // singular / collinear
        const inv = 1 / det;
        const c11 = m00 * m22 - m02 * m02;
        const c12 = m02 * m01 - m00 * m12;
        const c22 = m00 * m11 - m01 * m01;
        // Inverse (symmetric): rows of cofactors * inv
        const i00 = c00 * inv, i01 = c01 * inv, i02 = c02 * inv;
        const i10 = c01 * inv, i11 = c11 * inv, i12 = c12 * inv;
        const i20 = c02 * inv, i21 = c12 * inv, i22 = c22 * inv;

        const a = i00 * bx0 + i01 * bx1 + i02 * bx2;
        const b = i10 * bx0 + i11 * bx1 + i12 * bx2;
        const c = i20 * bx0 + i21 * bx1 + i22 * bx2;
        const d = i00 * by0 + i01 * by1 + i02 * by2;
        const e = i10 * by0 + i11 * by1 + i12 * by2;
        const f = i20 * by0 + i21 * by1 + i22 * by2;
        return [a, b, c, d, e, f];
    }

    isGoodQualityFrame(flowVectors, consensus) {
        if (!consensus) return false;
        if (flowVectors.length < this.params.minVectorCount) return false;
        if (consensus.confidence < this.params.minConsensusConfidence) return false;
        return true;
    }

    drawOverlay(width, height, imgWidth, imgHeight) {
        const ctx = this.overlayCtx;
        ctx.clearRect(0, 0, width, height);

        if (!this.lastFlowData) return;

        const flowRotation = this.currentFlowRotation || 0;
        if (flowRotation !== 0) {
            ctx.save();
            ctx.translate(width / 2, height / 2);
            ctx.rotate(flowRotation);
            ctx.translate(-width / 2, -height / 2);
        }

        const arrowScale = 3;

        for (const v of this.lastFlowData.vectors) {
            const [cx, cy] = this.videoView.videoToCanvasCoords(v.px, v.py);
            const [endX, endY] = this.videoView.videoToCanvasCoords(v.px + v.dx * arrowScale, v.py + v.dy * arrowScale);
            const dx = endX - cx;
            const dy = endY - cy;
            const mag = Math.sqrt(dx * dx + dy * dy);

            if (mag < 1) continue;

            const hue = v.isInlier ? 120 : 0;
            const sat = 80;
            const light = 40 + v.quality * 30;
            ctx.strokeStyle = `hsl(${hue}, ${sat}%, ${light}%)`;
            ctx.lineWidth = 1 + v.quality;

            ctx.beginPath();
            ctx.moveTo(cx, cy);
            ctx.lineTo(cx + dx, cy + dy);
            ctx.stroke();

            const angle = Math.atan2(dy, dx);
            const headLen = Math.min(mag * 0.3, 6);
            ctx.beginPath();
            ctx.moveTo(cx + dx, cy + dy);
            ctx.lineTo(cx + dx - headLen * Math.cos(angle - Math.PI / 6), cy + dy - headLen * Math.sin(angle - Math.PI / 6));
            ctx.moveTo(cx + dx, cy + dy);
            ctx.lineTo(cx + dx - headLen * Math.cos(angle + Math.PI / 6), cy + dy - headLen * Math.sin(angle + Math.PI / 6));
            ctx.stroke();
        }

        const showArrow = this.smoothedDirection.magnitude > 0.1 && this.smoothedDirection.confidence > 0.01;
        const [centerX, centerY] = this.videoView.videoToCanvasCoords(imgWidth / 2, imgHeight / 2);
        
        const isGoodFrame = this.lastFlowData?.isGoodFrame ?? true;
        const vectorCount = this.lastFlowData?.vectors?.length ?? 0;
        const consensusConf = this.lastFlowData?.consensus?.confidence ?? 0;
        
        ctx.font = '10px monospace';
        if (isGoodFrame) {
            ctx.fillStyle = 'rgba(255, 255, 0, 0.8)';
            ctx.fillText(`mag=${this.smoothedDirection.magnitude.toFixed(2)} conf=${this.smoothedDirection.confidence.toFixed(2)} vec=${vectorCount}`, centerX - 60, centerY + 50);
        } else {
            ctx.fillStyle = 'rgba(255, 100, 100, 0.9)';
            ctx.fillText(`BAD FRAME - vec=${vectorCount} conf=${consensusConf.toFixed(2)} (using last good)`, centerX - 100, centerY + 50);
        }
        
        if (showArrow) {
            const arrowLen = Math.min(width, height) * 0.15 * Math.min(1, this.smoothedDirection.magnitude / 5);
            const dx = Math.cos(this.smoothedDirection.angle) * arrowLen;
            const dy = Math.sin(this.smoothedDirection.angle) * arrowLen;

            const alpha = Math.min(1, this.smoothedDirection.confidence * 1.5);
            ctx.strokeStyle = `rgba(255, 255, 0, ${alpha})`;
            ctx.fillStyle = `rgba(255, 255, 0, ${alpha})`;
            ctx.lineWidth = 4;

            ctx.beginPath();
            ctx.moveTo(centerX - dx * 0.5, centerY - dy * 0.5);
            ctx.lineTo(centerX + dx, centerY + dy);
            ctx.stroke();

            const angle = this.smoothedDirection.angle;
            const headLen = arrowLen * 0.3;
            ctx.beginPath();
            ctx.moveTo(centerX + dx, centerY + dy);
            ctx.lineTo(centerX + dx - headLen * Math.cos(angle - Math.PI / 5), centerY + dy - headLen * Math.sin(angle - Math.PI / 5));
            ctx.lineTo(centerX + dx - headLen * Math.cos(angle + Math.PI / 5), centerY + dy - headLen * Math.sin(angle + Math.PI / 5));
            ctx.closePath();
            ctx.fill();

            ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
            ctx.font = '12px monospace';
            const rawAngle = ((this.smoothedDirection.angle * 180 / Math.PI) + 360) % 360;
            const angleDeg = (rawAngle + 90) % 360;
            ctx.fillText(`${angleDeg.toFixed(1)}° (${(this.smoothedDirection.confidence * 100).toFixed(0)}%)`, 
                        centerX + dx + 10, centerY + dy);
        }

        if (flowRotation !== 0) {
            ctx.restore();
        }
    }

    drawGraph() {
        const ctx = this.graphCtx;
        const w = this.graphCanvas.width;
        const h = this.graphCanvas.height;
        
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
        ctx.fillRect(0, 0, w, h);

        ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(0, h / 2);
        ctx.lineTo(w, h / 2);
        ctx.stroke();

        if (this.angleHistory.length < 2) return;

        ctx.strokeStyle = 'rgba(255, 255, 0, 0.8)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();

        for (let i = 0; i < this.angleHistory.length; i++) {
            const x = (i / this.maxHistoryLength) * w;
            const normalizedAngle = this.angleHistory[i].angle / Math.PI;
            const y = h / 2 - normalizedAngle * (h / 2 - 5);
            
            if (i === 0) {
                ctx.moveTo(x, y);
            } else {
                ctx.lineTo(x, y);
            }
        }
        ctx.stroke();

        ctx.fillStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.font = '9px monospace';
        ctx.fillText('Motion Angle', 5, 12);
        ctx.fillText('+180°', w - 30, 12);
        ctx.fillText('-180°', w - 30, h - 3);
    }
    
    createRandomIndividual() {
        return {
            frameSkip: Math.floor(Math.random() * 10) + 1,
            blurSize: (Math.floor(Math.random() * 8) * 2) + 1,
            maxFeatures: Math.floor(Math.random() * 46) * 10 + 50,
            minQuality: Math.floor(Math.random() * 11) * 0.05,
        };
    }
    
    mutateIndividual(individual) {
        const mutated = {...individual};
        const paramToMutate = Math.floor(Math.random() * 4);
        switch (paramToMutate) {
            case 0:
                mutated.frameSkip = Math.max(1, Math.min(10, individual.frameSkip + (Math.random() < 0.5 ? -1 : 1)));
                break;
            case 1:
                mutated.blurSize = Math.max(1, Math.min(15, individual.blurSize + (Math.random() < 0.5 ? -2 : 2)));
                if (mutated.blurSize % 2 === 0) mutated.blurSize++;
                break;
            case 2:
                mutated.maxFeatures = Math.max(50, Math.min(500, individual.maxFeatures + (Math.random() < 0.5 ? -10 : 10)));
                break;
            case 3:
                mutated.minQuality = Math.max(0, Math.min(0.5, individual.minQuality + (Math.random() < 0.5 ? -0.05 : 0.05)));
                mutated.minQuality = Math.round(mutated.minQuality * 20) / 20;
                break;
        }
        return mutated;
    }
    
    crossover(parent1, parent2) {
        return {
            frameSkip: Math.random() < 0.5 ? parent1.frameSkip : parent2.frameSkip,
            blurSize: Math.random() < 0.5 ? parent1.blurSize : parent2.blurSize,
            maxFeatures: Math.random() < 0.5 ? parent1.maxFeatures : parent2.maxFeatures,
            minQuality: Math.random() < 0.5 ? parent1.minQuality : parent2.minQuality,
        };
    }
    
    async evaluateFitness(individual) {
        this.params.frameSkip = individual.frameSkip;
        this.params.blurSize = individual.blurSize;
        this.params.maxFeatures = individual.maxFeatures;
        this.params.minQuality = individual.minQuality;
        
        if (updateGuiValues) updateGuiValues();
        
        this.invalidateCache();
        
        const frame = Math.floor(par.frame);
        const videoData = this.videoView?.videoData;
        if (!videoData) return 0;
        
        const image = videoData.getImage(frame);
        if (!image || !image.width) return 0;
        
        const {gray, width, height} = imageToGrayscale(image, this.params.blurSize);
        
        this.frameBuffer = [];
        this.frameBuffer.push({gray: gray.clone(), frame, width, height});
        
        const skipFrames = Math.max(1, Math.round(this.params.frameSkip));
        for (let i = 1; i <= skipFrames; i++) {
            const prevFrame = frame - i;
            if (prevFrame < 0) break;
            const prevImage = videoData.getImage(prevFrame);
            if (!prevImage || !prevImage.width) break;
            const {gray: prevGray} = imageToGrayscale(prevImage, this.params.blurSize);
            this.frameBuffer.unshift({gray: prevGray.clone(), frame: prevFrame, width, height});
            prevGray.delete();
        }
        
        if (this.params.technique === MOTION_TECHNIQUES.LINEAR_TRACKLET) {
            this.computeOpticalFlowLinearTracklet(frame, width, height, skipFrames);
        }
        
        gray.delete();
        for (const fb of this.frameBuffer) {
            if (fb.gray) fb.gray.delete();
        }
        this.frameBuffer = [];
        
        const confidence = this.lastFlowData?.consensus?.confidence ?? 0;
        const vectorCount = this.lastFlowData?.vectors?.length ?? 0;
        const inlierCount = this.lastFlowData?.consensus?.inlierCount ?? 0;
        
        const fitness = confidence * 0.6 + (Math.min(vectorCount, 100) / 100) * 0.2 + (Math.min(inlierCount, 50) / 50) * 0.2;
        
        return fitness;
    }
    
    async runOptimizationStep() {
        if (!this.optimizing || this.optimizeAborted) return false;
        
        const POPULATION_SIZE = 8;
        const ELITE_COUNT = 2;
        const MAX_NO_IMPROVE = 5;
        
        if (this.optimizePopulation.length === 0) {
            for (let i = 0; i < POPULATION_SIZE; i++) {
                this.optimizePopulation.push({
                    individual: this.createRandomIndividual(),
                    fitness: 0,
                });
            }
        }
        
        for (const member of this.optimizePopulation) {
            if (this.optimizeAborted) return false;
            member.fitness = await this.evaluateFitness(member.individual);
            
            this.drawOverlay(this.overlay.width, this.overlay.height, 
                this.videoView.videoData?.getImage(0)?.width ?? 1920, 
                this.videoView.videoData?.getImage(0)?.height ?? 1080);
            await new Promise(r => setTimeout(r, 50));
        }
        
        this.optimizePopulation.sort((a, b) => b.fitness - a.fitness);
        
        const bestThisGen = this.optimizePopulation[0];
        if (bestThisGen.fitness > this.optimizeBestFitness) {
            this.optimizeBestFitness = bestThisGen.fitness;
            this.optimizeBestParams = {...bestThisGen.individual};
            this.optimizeNoImproveCount = 0;
        } else {
            this.optimizeNoImproveCount++;
        }
        
        if (updateOptimizeStatus) {
            updateOptimizeStatus(this.optimizeGeneration, this.optimizeBestFitness, this.optimizeBestParams);
        }
        
        if (this.optimizeNoImproveCount >= MAX_NO_IMPROVE) {
            return false;
        }
        
        const newPopulation = [];
        for (let i = 0; i < ELITE_COUNT; i++) {
            newPopulation.push(this.optimizePopulation[i]);
        }
        
        while (newPopulation.length < POPULATION_SIZE) {
            const parent1 = this.optimizePopulation[Math.floor(Math.random() * ELITE_COUNT)].individual;
            const parent2 = this.optimizePopulation[Math.floor(Math.random() * Math.min(4, POPULATION_SIZE))].individual;
            let child = this.crossover(parent1, parent2);
            if (Math.random() < 0.3) {
                child = this.mutateIndividual(child);
            }
            newPopulation.push({individual: child, fitness: 0});
        }
        
        this.optimizePopulation = newPopulation;
        this.optimizeGeneration++;
        
        return true;
    }
    
    startOptimization() {
        this.optimizing = true;
        this.optimizeAborted = false;
        this.optimizePopulation = [];
        this.optimizeBestParams = null;
        this.optimizeBestFitness = -Infinity;
        this.optimizeGeneration = 0;
        this.optimizeNoImproveCount = 0;
        this.optimizeParamsBeforeStart = {
            frameSkip: this.params.frameSkip,
            blurSize: this.params.blurSize,
            maxFeatures: this.params.maxFeatures,
            minQuality: this.params.minQuality,
        };
    }
    
    abortOptimization() {
        this.optimizeAborted = true;
        this.optimizing = false;
        if (this.optimizeParamsBeforeStart) {
            this.params.frameSkip = this.optimizeParamsBeforeStart.frameSkip;
            this.params.blurSize = this.optimizeParamsBeforeStart.blurSize;
            this.params.maxFeatures = this.optimizeParamsBeforeStart.maxFeatures;
            this.params.minQuality = this.optimizeParamsBeforeStart.minQuality;
        }
        this.invalidateCache();
    }
    
    acceptOptimization() {
        this.optimizing = false;
        if (this.optimizeBestParams) {
            this.params.frameSkip = this.optimizeBestParams.frameSkip;
            this.params.blurSize = this.optimizeBestParams.blurSize;
            this.params.maxFeatures = this.optimizeBestParams.maxFeatures;
            this.params.minQuality = this.optimizeBestParams.minQuality;
        }
        this.invalidateCache();
    }
}

// UI, menu, panorama and {de,}serializeMotionAnalysis now live in
// CMotionAnalysisUI.js — external consumers should import from there.
