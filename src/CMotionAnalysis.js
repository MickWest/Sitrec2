import {
    GlobalDateTimeNode,
    Globals,
    guiMenus,
    NodeMan,
    registerFrameBlocker,
    setRenderOne,
    Sit,
    unregisterFrameBlocker
} from "./Globals";
import {isLocal} from "./configUtils";
import {par} from "./par";
import {ExportProgressWidget, getExportPrefix} from "./utils";

import {CNodeMaskOverlay} from "./nodes/CNodeMaskOverlay";
import {CNodeSpeedOverlay} from "./nodes/CNodeSpeedOverlay";
import {CNodeVelocityFromMotion} from "./nodes/CNodeVelocityFromMotion";
import {CNodeTrackFromVelocity} from "./nodes/CNodeTrackFromVelocity";
import {CNodeDisplayTrack} from "./nodes/CNodeDisplayTrack";
import {Color} from "three";
import {getCV, loadOpenCV} from "./openCVLoader";
import {applyConvolution} from "./nodes/CNodeVideoView";
import {getFlowAlignRotation, isAlignWithFlowEnabled, setAlignWithFlow, setMotionAnalyzerRef} from "./FlowAlignment";

let cv = null;
let analyzeWithEffects = false;
let exportWithEffects = false;

function getVideoEffectsFilterString() {
    let filter = '';
    const contrast = NodeMan.get("videoContrast", false);
    const brightness = NodeMan.get("videoBrightness", false);
    const blur = NodeMan.get("videoBlur", false);
    const greyscale = NodeMan.get("videoGreyscale", false);
    const hue = NodeMan.get("videoHue", false);
    const invert = NodeMan.get("videoInvert", false);
    const saturate = NodeMan.get("videoSaturate", false);
    
    if (contrast && contrast.v0 !== 1) filter += `contrast(${contrast.v0}) `;
    if (brightness && brightness.v0 !== 1) filter += `brightness(${brightness.v0}) `;
    if (blur && blur.v0 !== 0) filter += `blur(${blur.v0}px) `;
    if (greyscale && greyscale.v0 !== 0) filter += `grayscale(${greyscale.v0}) `;
    if (hue && hue.v0 !== 0) filter += `hue-rotate(${hue.v0}deg) `;
    if (invert && invert.v0 !== 0) filter += `invert(${invert.v0}) `;
    if (saturate && saturate.v0 !== 1) filter += `saturate(${saturate.v0}) `;
    
    return filter || 'none';
}

function applyVideoEffectsToCanvas(ctx, width, height) {
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

async function ensureOpenCVAndAnalyzer(menuItem, loadingText, defaultText) {
    const videoView = NodeMan.get("video", false);
    if (!videoView) {
        alert("No video view found.");
        return null;
    }

    const videoData = videoView.videoData;
    if (!videoData) {
        alert("No video data found.");
        return null;
    }

    if (!cv) {
        if (menuItem) menuItem.name(loadingText);
        try {
            await loadOpenCV();
            cv = getCV();
        } catch (e) {
            alert("Failed to load OpenCV: " + e.message);
            if (menuItem) menuItem.name(defaultText);
            return null;
        }
    }

    startAnalysis(videoView);

    return {videoView, videoData};
}

function calculateFrameOffsets(motionData, startFrame, endFrame, frameStep = 1, rotationAngle = 0) {
    const totalFrames = Math.ceil((endFrame - startFrame + 1) / frameStep);
    const frameData = [];
    let cumX = 0, cumY = 0;
    
    const cos = Math.cos(rotationAngle);
    const sin = Math.sin(rotationAngle);
    
    const alignFlow = rotationAngle !== 0;
    
    for (let i = 0; i < totalFrames; i++) {
        const frame = startFrame + i * frameStep;
        if (i > 0) {
            if (frameStep === 1) {
                const md = motionData[frame];
                const dx = -md.dx;
                const dy = -md.dy;
                if (alignFlow) {
                     const rotatedX = dx * cos - dy * sin;
                    const magnitude = Math.sqrt(dx * dx + dy * dy);
                    cumX += rotatedX >= 0 ? magnitude : -magnitude;
                } else {
                    cumX += dx * cos - dy * sin;
                    cumY += dx * sin + dy * cos;
                }
            } else {
                for (let f = frame - frameStep + 1; f <= frame; f++) {
                    const md = motionData[f];
                    const dx = -md.dx;
                    const dy = -md.dy;
                    if (alignFlow) {
                        const rotatedX = dx * cos - dy * sin;
                        const magnitude = Math.sqrt(dx * dx + dy * dy);
                        cumX += rotatedX >= 0 ? magnitude : -magnitude;
                    } else {
                        cumX += dx * cos - dy * sin;
                        cumY += dx * sin + dy * cos;
                    }
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

function imageToGrayscale(image, blurSize) {
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

const MOTION_TECHNIQUES = {
    SPARSE_CONSENSUS: 'Sparse + Consensus',
    LINEAR_TRACKLET: 'Linear Tracklet',
    PHASE_CORRELATION: 'Phase Correlation',
    ECC_EUCLIDEAN: 'ECC Euclidean',
    AFFINE_RANSAC: 'Affine RANSAC',
};

class MotionAnalyzer {
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
            eccIterations: 50,
            eccEpsilon: 0.001,
            ransacThreshold: 3.0,
            minVectorCount: 5,
            minConsensusConfidence: 0.1,
            linearityThreshold: 0.9,
            spacingThreshold: 0.5,
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
        
        this.resultCache = new Map();
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
        this.frameBuffer = [];
        this.staticHistory.clear();
        this.angleHistory = [];
        this.smoothedDirection = {x: 0, y: 0, angle: 0, magnitude: 0, confidence: 0, rotation: 0};
        this.lastFlowData = null;
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

    getMotionDataForAllFrames() {
        const data = [];
        const goodFrameIndices = [];
        
        for (let f = 0; f < Sit.frames; f++) {
            const cached = this.resultCache.get(f);
            if (cached && cached.smoothedDirection && !cached.incomplete) {
                const isGoodFrame = cached.flowData?.isGoodFrame ?? true;
                if (isGoodFrame) {
                    data.push({
                        dx: cached.flowData?.consensus?.dx ?? cached.smoothedDirection.x,
                        dy: cached.flowData?.consensus?.dy ?? cached.smoothedDirection.y,
                        confidence: cached.flowData?.consensus?.confidence ?? cached.smoothedDirection.confidence,
                        isGood: true,
                    });
                    goodFrameIndices.push(f);
                } else {
                    data.push({dx: 0, dy: 0, confidence: 0, isGood: false});
                }
            } else {
                data.push({dx: 0, dy: 0, confidence: 0, isGood: false});
            }
        }
        
        if (goodFrameIndices.length === 0) {
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
        
        this.maskOverlayNode.maskCtx.clearRect(0, 0, this.maskOverlayNode.maskCanvas.width, this.maskOverlayNode.maskCanvas.height);
        
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
        
        const ctx = this.maskOverlayNode.maskCtx;
        ctx.fillStyle = 'rgba(255, 0, 0, 1)';
        
        for (const {x, y} of invariantPixels) {
            ctx.beginPath();
            ctx.arc(x, y, this.autoMaskSpread, 0, Math.PI * 2);
            ctx.fill();
        }
        
        this.maskOverlayNode.saveMask();
        this.onMaskChange();
        setRenderOne(true);
        console.log("AutoMask: complete");
    }

    createOverlays() {
        if (this.overlaysCreated) return;
        this.overlaysCreated = true;

        this.maskOverlayNode = new CNodeMaskOverlay({
            id: "motionMaskOverlay",
            overlayView: this.videoView,
            brushSize: this.brushSize,
            visible: false,
            onMaskChange: () => this.onMaskChange(),
        });

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

        this.frameBuffer.push({gray: gray.clone(), frame, width: imgWidth, height: imgHeight});
        
        while (this.frameBuffer.length > this.maxBufferSize) {
            const old = this.frameBuffer.shift();
            if (old.gray) old.gray.delete();
        }

        const skipFrames = Math.max(1, Math.round(this.params.frameSkip));
        const targetFrame = frame - skipFrames;
        let compareIdx = this.frameBuffer.findIndex(entry => entry.frame === targetFrame);
        
        if (compareIdx < 0 && frame >= skipFrames) {
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
        
        const {flowVectors, consensus} = result;
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

        this.lastFlowData = {vectors: flowVectors, consensus, isGoodFrame};
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
        if (typeof cv.estimateAffinePartial2D !== 'function') {
            if (!this._affineWarned) {
                console.warn("cv.estimateAffinePartial2D not available, falling back to Sparse + Consensus");
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
            transform = cv.estimateAffinePartial2D(prevPtsMat, nextPtsMat, inliersMask, cv.RANSAC, this.params.ransacThreshold);
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

    computeLinearTracklet(frame, imgWidth, imgHeight, skipFrames) {
        const videoData = this.videoView.videoData;
        if (!videoData) return {flowVectors: [], consensus: null};
        
        const startFrame = frame - skipFrames;
        if (startFrame < 0) return {flowVectors: [], consensus: null};
        
        const grayFrames = [];
        for (let f = startFrame; f <= frame; f++) {
            const entry = this.frameBuffer.find(e => e.frame === f);
            if (entry) {
                grayFrames.push(entry.gray);
            } else {
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
        }
        
        if (flowVectors.length < 3) {
            return {flowVectors: [], consensus: null};
        }
        
        const consensus = this.findConsensusDirection(flowVectors);
        return {flowVectors, consensus};
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
        
        const consensus = this.findConsensusDirection(flowVectors);
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

let motionAnalyzer = null;
let updateOptimizeStatus = null;
let updateGuiValues = null;
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
        analyzeMenuItem.name("Analyze Motion");
    }
}

export async function toggleMotionAnalysis() {
    if (motionAnalyzer && motionAnalyzer.active) {
        motionAnalyzer.stop();
        removeParamSliders();
        if (analyzeMenuItem) {
            analyzeMenuItem.name("Analyze Motion");
        }
        setRenderOne(true);
        return;
    }

    await ensureOpenCVAndAnalyzer(analyzeMenuItem, "Loading OpenCV...", "Analyze Motion");
}

let paramControllers = [];

function startAnalysis(videoView) {
    if (!motionAnalyzer) {
        motionAnalyzer = new MotionAnalyzer(videoView);
    }
    setMotionAnalyzerRef(motionAnalyzer);
    motionAnalyzer.start();
    
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
}

let motionFolder = null;
let motionTrackCounter = 0;
let createTrackMenuItem = null;

async function analyzeAllFrames(progressCallback) {
    if (!motionAnalyzer) return false;
    
    const aFrame = Sit.aFrame || 0;
    const bFrame = Sit.bFrame ?? (Sit.frames - 1);
    const totalFrames = bFrame - aFrame + 1;
    
    const savedPaused = par.paused;
    Globals.justVideoAnalysis = true;
    par.paused = false;
    
    while (!motionAnalyzer.isCacheFull()) {
        const analyzed = motionAnalyzer.resultCache.size;
        if (progressCallback) {
            progressCallback(analyzed, totalFrames);
        }
        await new Promise(r => setTimeout(r, 100));
    }
    
    par.paused = savedPaused;
    Globals.justVideoAnalysis = false;
    return true;
}

async function createTrackFromMotion() {
    const result = await ensureOpenCVAndAnalyzer(createTrackMenuItem, "Loading OpenCV...", "Create Track from Motion");
    if (!result) return;

    if (createTrackMenuItem) createTrackMenuItem.name("Analyzing... 0%");
    
    await analyzeAllFrames((current, total) => {
        const pct = Math.round(100 * current / total);
        if (createTrackMenuItem) createTrackMenuItem.name(`Analyzing... ${pct}%`);
    });

    if (createTrackMenuItem) createTrackMenuItem.name("Creating track...");

    const originNode = NodeMan.get("LOSTraverseSelect", false) 
        ?? NodeMan.get("targetTrack", false)
        ?? NodeMan.get("cameraTrack", false);
    
    if (!originNode) {
        alert("No origin track found. Need a target or camera track to determine start position.");
        if (createTrackMenuItem) createTrackMenuItem.name("Create Track from Motion");
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

    if (createTrackMenuItem) createTrackMenuItem.name("Create Track from Motion");
    setRenderOne(true);
    console.log(`Created motion track '${trackId}' from ${motionAnalyzer.resultCache.size} analyzed frames, ${metersPerPixel.toFixed(3)} m/px`);
}

const MAX_PANORAMA_WIDTH = 20000;
const PANO_VIDEO_4K_WIDTH = 3840;
const PANO_VIDEO_4K_HEIGHT = 2160;
let exportPanoMenuItem = null;
let exportPanoVideoMenuItem = null;
let stabilizeMenuItem = null;
let stabilizationEnabled = false;
let panoCrop = 0;
let useMaskInPano = true;
let panoFrameStep = 1;
let removeOuterBlack = false;

async function exportMotionPanorama() {
    const result = await ensureOpenCVAndAnalyzer(exportPanoMenuItem, "Loading OpenCV...", "Export Motion Panorama");
    if (!result) return;
    const {videoData} = result;

    if (!motionAnalyzer.isCacheFull()) {
        if (exportPanoMenuItem) exportPanoMenuItem.name("Analyzing... 0%");
        await analyzeAllFrames((current, total) => {
            const pct = Math.round(100 * current / total);
            if (exportPanoMenuItem) exportPanoMenuItem.name(`Analyzing... ${pct}%`);
        });
    }

    if (exportPanoMenuItem) exportPanoMenuItem.name("Building panorama...");

    const startFrame = Sit.aFrame;
    const endFrame = Sit.bFrame;
    const crop = panoCrop;
    const motionData = motionAnalyzer.getMotionDataForAllFrames();

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
    statusText.textContent = 'Building panorama... 0%';
    
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
        
        statusText.textContent = `Loading frame ${fd.frame}... (${i+1}/${totalFrames})`;
        
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
            const skipInfo = skippedFrames > 0 ? ` (${skippedFrames} skipped)` : '';
            statusText.textContent = `Building panorama... ${pct}% (frame ${i+1}/${totalFrames})${skipInfo}`;
            if (exportPanoMenuItem) exportPanoMenuItem.name(`Rendering... ${pct}%`);
            await new Promise(r => setTimeout(r, 0));
        }
    }

    updatePreview();
    statusText.textContent = 'Saving...';
    Globals.justVideoAnalysis = false;
    par.paused = savedPaused;
    par.frame = savedFrame;
    
    if (exportPanoMenuItem) exportPanoMenuItem.name("Saving...");

    panoCanvas.toBlob((blob) => {
        const filename = `${getExportPrefix()}_motion_panorama_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.png`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.click();
        URL.revokeObjectURL(url);
        
        console.log(`Motion panorama exported: ${filename}`);
        if (exportPanoMenuItem) exportPanoMenuItem.name("Export Motion Panorama");
        
        document.body.removeChild(previewOverlay);
    }, 'image/png');
}

async function exportPanoVideo() {
    const result = await ensureOpenCVAndAnalyzer(exportPanoVideoMenuItem, "Loading OpenCV...", "Export Animated Pano");
    if (!result) return;
    const {videoData} = result;

    if (!motionAnalyzer.isCacheFull()) {
        if (exportPanoVideoMenuItem) exportPanoVideoMenuItem.name("Analyzing... 0%");
        await analyzeAllFrames((current, total) => {
            const pct = Math.round(100 * current / total);
            if (exportPanoVideoMenuItem) exportPanoVideoMenuItem.name(`Analyzing... ${pct}%`);
        });
    }

    if (exportPanoVideoMenuItem) exportPanoVideoMenuItem.name("Building panorama...");

    const startFrame = Sit.aFrame;
    const endFrame = Sit.bFrame;
    const crop = panoCrop;
    const motionData = motionAnalyzer.getMotionDataForAllFrames();

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
            if (exportPanoVideoMenuItem) exportPanoVideoMenuItem.name(`Pano... ${pct}%`);
            await new Promise(r => setTimeout(r, 0));
        }
    }

    if (exportPanoVideoMenuItem) exportPanoVideoMenuItem.name("Rendering video...");

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
        alert("Video encoding not supported in this browser");
        Globals.justVideoAnalysis = false;
        par.paused = savedPaused;
        if (exportPanoVideoMenuItem) exportPanoVideoMenuItem.name("Export Pano Video");
        return;
    }

    const formatId = encodingSupport.h264 ? 'mp4-h264' : 'webm-vp8';
    const bestFormat = await getBestFormatForResolution(formatId, outputWidth, outputHeight);
    if (!bestFormat.formatId) {
        alert(`Video export failed: ${bestFormat.reason}`);
        Globals.justVideoAnalysis = false;
        par.paused = savedPaused;
        if (exportPanoVideoMenuItem) exportPanoVideoMenuItem.name("Export Pano Video");
        return;
    }

    const extension = getVideoExtension(bestFormat.formatId);
    const fps = Sit.fps;

    const progress = new ExportProgressWidget('Exporting pano video...', totalFrames);

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
                if (exportPanoVideoMenuItem) exportPanoVideoMenuItem.name(`Video... ${pct}%`);
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
        alert('Pano video export failed: ' + e.message);
    } finally {
        progress.remove();
        par.frame = savedFrame;
        Globals.justVideoAnalysis = false;
        par.paused = savedPaused;
        if (exportPanoVideoMenuItem) exportPanoVideoMenuItem.name("Export Pano Video");
        setRenderOne(true);
    }
}

async function stabilizeVideoFromMotion() {
    const result = await ensureOpenCVAndAnalyzer(stabilizeMenuItem, "Loading OpenCV...", "Stabilize Video");
    if (!result) return;
    const {videoData} = result;

    if (!motionAnalyzer.isCacheFull()) {
        if (stabilizeMenuItem) stabilizeMenuItem.name("Analyzing... 0%");
        await analyzeAllFrames((current, total) => {
            const pct = Math.round(100 * current / total);
            if (stabilizeMenuItem) stabilizeMenuItem.name(`Analyzing... ${pct}%`);
        });
    }

    if (stabilizeMenuItem) stabilizeMenuItem.name("Building stabilization...");

    const motionData = motionAnalyzer.getMotionDataForAllFrames();

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

    if (stabilizeMenuItem) stabilizeMenuItem.name("Disable Stabilization");
    console.log(`Video stabilization enabled with ${stabilizationData.size} frames of motion data`);
}

function toggleStabilization() {
    const videoView = NodeMan.get("video", false);
    if (!videoView || !videoView.videoData) return;

    if (stabilizationEnabled) {
        videoView.videoData.setStabilizationEnabled(false);
        stabilizationEnabled = false;
        if (stabilizeMenuItem) stabilizeMenuItem.name("Stabilize Video");
        console.log("Video stabilization disabled");
    } else {
        // If we have cached motion data, re-enable; otherwise run full analysis
        if (videoView.videoData.stabilizationData && videoView.videoData.stabilizationData.size > 0) {
            videoView.videoData.setStabilizationEnabled(true);
            stabilizationEnabled = true;
            if (stabilizeMenuItem) stabilizeMenuItem.name("Disable Stabilization");
            console.log("Video stabilization re-enabled");
        } else {
            stabilizeVideoFromMotion();
        }
    }
}

export function addMotionAnalysisMenu() {
    if (!guiMenus.view) return;
    
    motionFolder = guiMenus.video.addFolder("Motion Analysis").close().perm();
    
    const menuActions = {
        analyzeMotion: toggleMotionAnalysis,
        createTrack: createTrackFromMotion,
        exportPanorama: exportMotionPanorama,
        exportPanoVideo: exportPanoVideo,
        stabilizeVideo: toggleStabilization,
    };

    analyzeMenuItem = motionFolder.add(menuActions, 'analyzeMotion')
        .name("Analyze Motion")
        .tooltip("Toggle real-time motion analysis overlay on video")
        .perm();

    createTrackMenuItem = motionFolder.add(menuActions, 'createTrack')
        .name("Create Track from Motion")
        .tooltip("Analyze all frames and create a ground track from motion vectors")
        .perm();

    const flowParams = {
        get alignWithFlow() { return isAlignWithFlowEnabled(); }, 
        set alignWithFlow(v) { 
            setAlignWithFlow(v); 
            setRenderOne(true);
        }
    };
    motionFolder.add(flowParams, 'alignWithFlow')
        .name("Align with Flow")
        .tooltip("Rotate image so motion direction is horizontal")
        .perm();

    const panoFolder = motionFolder.addFolder("Panorama").close().perm();
    
    exportPanoMenuItem = panoFolder.add(menuActions, 'exportPanorama')
        .name("Export Motion Panorama")
        .tooltip("Create a panorama image from video frames using motion tracking offsets")
        .perm();

    exportPanoVideoMenuItem = panoFolder.add(menuActions, 'exportPanoVideo')
        .name("Export Pano Video")
        .tooltip("Create a 4K video showing the panorama with video frame overlay")
        .perm();

    stabilizeMenuItem = panoFolder.add(menuActions, 'stabilizeVideo')
        .name("Stabilize Video")
        .tooltip("Stabilize video using global motion analysis (removes camera shake)")
        .perm();

    const panoParams = {
        get panoCrop() { return panoCrop; }, set panoCrop(v) { panoCrop = v; },
        get useMaskInPano() { return useMaskInPano; }, set useMaskInPano(v) { useMaskInPano = v; },
        get panoFrameStep() { return panoFrameStep; }, set panoFrameStep(v) { panoFrameStep = v; },
        get analyzeWithEffects() { return analyzeWithEffects; }, set analyzeWithEffects(v) { analyzeWithEffects = v; },
        get exportWithEffects() { return exportWithEffects; }, set exportWithEffects(v) { exportWithEffects = v; },
        get removeOuterBlack() { return removeOuterBlack; }, set removeOuterBlack(v) { removeOuterBlack = v; }
    };
    panoFolder.add(panoParams, 'panoFrameStep', 1, 60, 1)
        .name("Pano Frame Step")
        .tooltip("How many frames to step between each panorama frame (1 = every frame)")
        .perm();
    panoFolder.add(panoParams, 'panoCrop', 0, 100, 1)
        .name("Panorama Crop")
        .tooltip("Pixels to crop from each edge of video frames")
        .perm();
    panoFolder.add(panoParams, 'useMaskInPano')
        .name("Use Mask in Pano")
        .tooltip("Apply motion tracking mask as transparency when rendering panorama")
        .perm();
    panoFolder.add(panoParams, 'analyzeWithEffects')
        .name("Analyze With Effects")
        .tooltip("Apply video adjustments (contrast, etc.) to frames used for motion analysis")
        .perm();
    panoFolder.add(panoParams, 'exportWithEffects')
        .name("Export With Effects")
        .tooltip("Apply video adjustments to panorama exports")
        .perm();
    panoFolder.add(panoParams, 'removeOuterBlack')
        .name("Remove Outer Black")
        .tooltip("Make black pixels at the edges of each row transparent")
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
    
    const trackingFolder = motionFolder.addFolder("Tracking Parameters").close();
    paramControllers.push(trackingFolder);
    
    if (isLocal || Globals.userID === 1) {
        const techniqueOptions = Object.values(MOTION_TECHNIQUES);
        paramControllers.push(trackingFolder.add(p, 'technique', techniqueOptions).name("Technique").onChange((newTechnique) => {
            console.log("Technique changed to:", newTechnique);
            invalidate();
            removeParamSliders();
            createParamSliders();
        }).tooltip("Motion estimation algorithm"));
    }
    
    const isTracklet = p.technique === MOTION_TECHNIQUES.LINEAR_TRACKLET;
    paramControllers.push(trackingFolder.add(p, 'frameSkip', 1, 10, 1)
        .name(isTracklet ? "Tracklet Length" : "Frame Skip")
        .onChange(invalidate)
        .tooltip(isTracklet ? "Number of frames in tracklet (longer = stricter coherence)" : "Frames between comparisons (higher = detect slower motion)"));
    paramControllers.push(trackingFolder.add(p, 'blurSize', 1, 15, 2).name("Blur Size").onChange(invalidate)
        .tooltip("Gaussian blur for macro features (odd numbers)"));
    paramControllers.push(trackingFolder.add(p, 'minMotion', 0, 2, 0.1).name("Min Motion").onChange(invalidate)
        .tooltip("Minimum motion magnitude (pixels/frame)"));
    paramControllers.push(trackingFolder.add(p, 'maxMotion', 10, 200, 5).name("Max Motion").onChange(invalidate)
        .tooltip("Maximum motion magnitude"));
    paramControllers.push(trackingFolder.add(p, 'smoothingAlpha', 0.5, 0.99, 0.01).name("Smoothing").onChange(invalidate)
        .tooltip("Direction smoothing (higher = more smoothing)"));
    paramControllers.push(trackingFolder.add(p, 'minVectorCount', 1, 50, 1).name("Min Vector Count").onChange(invalidate)
        .tooltip("Minimum number of motion vectors for a valid frame"));
    paramControllers.push(trackingFolder.add(p, 'minConsensusConfidence', 0, 0.5, 0.01).name("Min Confidence").onChange(invalidate)
        .tooltip("Minimum consensus confidence for a valid frame"));
    
    const usesFeatures = p.technique === MOTION_TECHNIQUES.SPARSE_CONSENSUS || p.technique === MOTION_TECHNIQUES.AFFINE_RANSAC || p.technique === MOTION_TECHNIQUES.LINEAR_TRACKLET;
    if (usesFeatures) {
        paramControllers.push(trackingFolder.add(p, 'maxFeatures', 50, 500, 10).name("Max Features").onChange(invalidate)
            .tooltip("Maximum tracked features"));
        paramControllers.push(trackingFolder.add(p, 'minDistance', 5, 50, 1).name("Min Distance").onChange(invalidate)
            .tooltip("Minimum distance between features"));
        paramControllers.push(trackingFolder.add(p, 'qualityLevel', 0.001, 0.1, 0.001).name("Quality Level").onChange(invalidate)
            .tooltip("Feature detection quality threshold"));
        paramControllers.push(trackingFolder.add(p, 'maxTrackError', 5, 50, 1).name("Max Track Error").onChange(invalidate)
            .tooltip("Maximum tracking error threshold"));
    }
    
    if (p.technique === MOTION_TECHNIQUES.SPARSE_CONSENSUS) {
        paramControllers.push(trackingFolder.add(p, 'minQuality', 0, 1, 0.05).name("Min Quality").onChange(invalidate)
            .tooltip("Minimum quality to display arrow"));
        paramControllers.push(trackingFolder.add(p, 'staticThreshold', 0.1, 2, 0.1).name("Static Threshold").onChange(invalidate)
            .tooltip("Motion below this is considered static (HUD)"));
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
    
    updateGuiValues = () => {
        for (const ctrl of paramControllers) {
            if (ctrl && ctrl.updateDisplay) {
                try { ctrl.updateDisplay(); } catch (e) {}
            }
        }
    };
    
    updateOptimizeStatus = (gen, fitness, bestParams) => {
        if (bestParams) {
            statusText.value = `Gen ${gen}: fit=${fitness.toFixed(3)} [fs=${bestParams.frameSkip} blur=${bestParams.blurSize} feat=${bestParams.maxFeatures} qual=${bestParams.minQuality.toFixed(2)}]`;
        } else {
            statusText.value = `Gen ${gen}: fit=${fitness.toFixed(3)}`;
        }
        if (statusCtrl) statusCtrl.updateDisplay();
    };
    
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
        
        if (!cv) {
            await loadOpenCV();
            cv = getCV();
        }
        doRestore();
    }
}
