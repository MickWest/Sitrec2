/**
 * Module-level UI and pixel-processing helpers extracted from CNodeVideoView.
 *
 * - addFiltersToVideoNode(videoNode): builds the Video Effects / Processing /
 *   Forensics (ELA + Noise) GUI panels and wires controls into the passed-in node.
 * - applyConvolution / applyConvolutionToImage / applyEchoEffect / applyELAOutputExpansion
 *   and related helpers: pure(-ish) pixel processing operations invoked from
 *   CNodeVideoView.renderCanvas and the ELA/Noise pipelines.
 *
 * No `this` coupling; helpers operate on `videoView` passed by the caller,
 * accessing only its public/underscore-prefixed state.
 */

import {CustomManager, guiMenus, NodeMan, setRenderOne} from "../Globals";
import {t} from "../i18n";
import {CNodeGUIFlag, CNodeGUISelect, CNodeGUIValue} from "./CNodeGUIValue";
import {CNodeConstant} from "./CNode";
import {VIDEO_CONTROL_DEFINITIONS} from "../VideoControlDefinitions";
import {CNodeGridOverlay} from "./CNodeGridOverlay";
import {EventManager} from "../CEventManager";
import {addStarOptimizeControls} from "../starTrack/StarAdjustOptimize";
import {viewMenuKey} from "../ViewUIBarMenus";
import {addVideoQPGraphMenu} from "../VideoQPGraph";
import {addVideoTonalGraphMenu} from "../VideoTonalGraph";
import {addVideoNoisePatternMenu} from "../VideoNoisePattern";

// Top-level GUI folders are shared across CNodeVideoView instances — the first
// node through addFiltersToVideoNode creates them. Each Forensics tool has a
// title-bar checkbox that controls its display independently of folder expansion.
export let guiVideoEffectsFolder = null;
export let guiVideoProcessingFolder = null;
export let guiVideoForensicsFolder = null;
export let guiVideoELAFolder = null;
export let guiVideoNoiseFolder = null;

const TONAL_ENDPOINT_PI = Math.PI;
const TONAL_REGION_WIDTH = 0.25;
const TONAL_REGION_INV_WIDTH = 1 / TONAL_REGION_WIDTH;
const TONAL_LUMA_R = 0.299;
const TONAL_LUMA_G = 0.587;
const TONAL_LUMA_B = 0.114;

export function addFiltersToVideoNode(videoNode) {

    if (guiVideoEffectsFolder === null) {
        guiVideoEffectsFolder = guiMenus.video.addFolder(t("videoView.folders.videoAdjustments")).close().perm()
            .tooltip(t("videoView.folderTooltips.videoAdjustments"));
    }

    if (guiVideoProcessingFolder === null) {
        guiVideoProcessingFolder = guiMenus.video.addFolder(t("videoView.folders.videoProcessing")).close().perm()
            .tooltip(t("videoView.folderTooltips.videoProcessing"));
    }

    if (guiVideoForensicsFolder === null) {
        guiVideoForensicsFolder = guiMenus.video.addFolder(t("videoView.folders.forensics")).close().perm()
            .tooltip(t("videoView.folderTooltips.forensics"));
        guiVideoForensicsFolder.onOpenClose(() => setRenderOne(true));
    }

    if (guiVideoELAFolder === null) {
        guiVideoELAFolder = guiVideoForensicsFolder.addFolder(t("videoView.folders.errorLevelAnalysis")).close().perm()
            .tooltip(t("videoView.folderTooltips.errorLevelAnalysis"));
        guiVideoELAFolder.onOpenClose(() => setRenderOne(true));
    }

    if (guiVideoNoiseFolder === null) {
        guiVideoNoiseFolder = guiVideoForensicsFolder.addFolder(t("videoView.folders.noiseAnalysis")).close().perm()
            .tooltip(t("videoView.folderTooltips.noiseAnalysis"));
        guiVideoNoiseFolder.onOpenClose(() => setRenderOne(true));
        addVideoQPGraphMenu(guiVideoForensicsFolder);
        addVideoTonalGraphMenu(guiVideoForensicsFolder);
        addVideoNoisePatternMenu(guiVideoForensicsFolder);
    }

    const controls = {};
    const folders = {
        adjustments: guiVideoEffectsFolder,
        processing: guiVideoProcessingFolder,
        ela: guiVideoELAFolder,
        noise: guiVideoNoiseFolder,
    };

    const updateConvolutionControlVisibility = () => {
        const filterType = controls.convolutionFilter.value;
        controls.sharpenAmount.show(filterType === "sharpen");
        controls.edgeDetectThreshold.show(filterType === "edgeDetect");
        controls.embossDepth.show(filterType === "emboss");
    };
    const updateCurvesControlVisibility = () => {
        controls.showCurves.guiEntry?.show(controls.curves.value === true);
        videoNode.updateCurvesVisibility?.();
    };
    const updateELAExpandControlVisibility = () => {
        const method = controls.elaExpandMethod.value;
        controls.elaContrastClipPercent.show(method === "autoContrast" || method === "autoContrastChannels");
    };

    // These callbacks belong to the first view that creates the shared controls.
    // Reusing a node for a mirror/second video must not redirect processing to that view.
    const handlers = {
        levels: () => {
            videoNode.updateLevelsVisibility?.();
            videoNode.invalidateLevelsResult?.();
        },
        histogram: () => videoNode.updateHistogramVisibilityFromVideoAdjustments?.(),
        render: () => setRenderOne(true),
        curves: updateCurvesControlVisibility,
        curvesView: () => videoNode.updateCurvesVisibility?.(),
        restartEcho: () => videoNode.restartFullABEchoIfActive(),
        fullABEcho: () => {
            if (controls.fullABEcho.value) {
                controls.fullABBlend.value = false;
                controls.fullABExposure.value = false;
                if (!controls.echoMin.value && !controls.echoMax.value) controls.echoMax.value = true;
                videoNode.startFullABEcho();
            } else {
                videoNode.stopFullABEcho();
            }
        },
        fullABBlend: () => {
            if (controls.fullABBlend.value) {
                controls.fullABEcho.value = false;
                controls.fullABExposure.value = false;
                videoNode.startFullABBlend();
            } else {
                videoNode.stopFullABBlend();
            }
        },
        fullABExposure: () => {
            if (controls.fullABExposure.value) {
                controls.fullABEcho.value = false;
                controls.fullABBlend.value = false;
                videoNode.startFullABExposure();
            } else {
                videoNode.stopFullABExposure();
            }
        },
        ela: () => videoNode.invalidateELAResult(),
        noise: () => videoNode.invalidateNoiseResult(),
        elaExpand: () => {
            updateELAExpandControlVisibility();
            videoNode.invalidateELAResult();
            setRenderOne(true);
        },
        noiseMode: () => {
            videoNode.invalidateNoiseResult();
            setRenderOne(true);
        },
        convolution: () => {
            updateConvolutionControlVisibility();
            setRenderOne(true);
        },
    };

    const nodeTypes = {value: CNodeGUIValue, flag: CNodeGUIFlag, select: CNodeGUISelect, constant: CNodeConstant};
    for (const definition of VIDEO_CONTROL_DEFINITIONS) {
        const {input, kind, folder, node, onChange, textKey} = definition;
        // A second video view (or a mirror) finds the nodes that the first view made.
        // Constructors can change their arguments (e.g. translated labels), so pass a copy.
        controls[input] = NodeMan.get(node.id, false) ?? new nodeTypes[kind]({
            ...node, ...(onChange ? {onChange: handlers[onChange]} : {}),
            ...(textKey ? {desc: t(`${textKey}.label`), tip: t(`${textKey}.tooltip`)} : {}),
        }, folders[folder]);
    }

    for (const definition of VIDEO_CONTROL_DEFINITIONS) {
        const node = controls[definition.input];
        if (definition.folderToggle) node.guiEntry?.asFolderToggle();
        if (definition.keepLive) node.guiEntry?.keepLiveWhenFolderOff();
        if (definition.share) node.guiEntry?.shareAs(viewMenuKey("video", definition.share));
    }

    videoNode.addMoreInputs(controls);
    videoNode.updateLevelsVisibility?.();
    updateCurvesControlVisibility();
    updateELAExpandControlVisibility();
    updateConvolutionControlVisibility();

    const reset = {
        resetFilters: () => {
            for (const definition of VIDEO_CONTROL_DEFINITIONS) {
                if (definition.reset === "preserve") continue;
                if (definition.reset === "levels" && videoNode.levelsView) continue;
                const node = videoNode.inputs[definition.input];
                if (!node) continue;
                const value = definition.node.value;
                if (definition.kind === "constant") {
                    node.value = value;
                    node.guiEntry?.updateDisplay();
                } else if (typeof node.setValue === "function") {
                    node.setValue(value);
                } else {
                    node.guiEntry.setValue(value);
                }
            }
            if (videoNode.levelsView) videoNode.levelsView.resetLevels();
            else videoNode.invalidateLevelsResult?.();
            videoNode.curvesView?.resetCurve();
            videoNode.invalidateELAResult();
            videoNode.invalidateNoiseResult();
            videoNode.updateLevelsVisibility?.();
            updateCurvesControlVisibility();
            updateELAExpandControlVisibility();
            updateConvolutionControlVisibility();
            setRenderOne(true);
        }
    };

    // Folder shells survive a sitch switch; their non-permanent controls do not.
    // Add these once per scene; a second video view finds them already there.
    if (!guiVideoEffectsFolder.controllers.some(controller => controller.property === "resetFilters")) {
        guiVideoEffectsFolder.add(reset, "resetFilters")
            .name(t("videoView.resetVideoAdjustments.label")).tooltip(t("videoView.resetVideoAdjustments.tooltip"))
            .keepLiveWhenFolderOff();
        guiVideoEffectsFolder.add({
            exportSourceVideo: () => CustomManager?.videoExportManager?.exportSourceVideo(),
        }, "exportSourceVideo")
            .name(t("videoExport.renderSource.label")).tooltip(t("videoExport.renderSource.tooltip"))
            .setLabelColor("#90EE90").keepLiveWhenFolderOff();
        guiVideoProcessingFolder.add({makeVideo: () => videoNode.makeProcessedVideo()}, "makeVideo")
            .name(t("videoView.makeVideo.label")).tooltip(t("videoView.makeVideo.tooltip"));
    }

    // The optimizer follows the controls it searches, once per shared folder.
    addStarOptimizeControls(guiVideoEffectsFolder);

    EventManager.addEventListener("abFrameChanged", () => {
        videoNode.restartFullABEchoIfActive();
    });

    if (!NodeMan.exists("videoGridOverlay")) {
        const gridFolder = guiMenus.video.addFolder(t("videoView.folders.grid")).close()
            .tooltip(t("videoView.folderTooltips.grid"));

        const gridOverlay = new CNodeGridOverlay({
            id: "videoGridOverlay",
            overlayView: videoNode,
        });

        gridFolder.add(gridOverlay, "gridShow").name(t("videoView.gridShow.label")).listen().onChange((value) => {
            gridOverlay.setShow(value);
        }).tooltip(t("videoView.gridShow.tooltip")).shareAs(viewMenuKey("video", "grid")).asFolderToggle();

        gridFolder.add(gridOverlay, "gridSize", 1, 128, 0.1).name(t("videoView.gridSize.label")).listen().onChange(() => {
            setRenderOne(true);
        }).tooltip(t("videoView.gridSize.tooltip"));

        gridFolder.add(gridOverlay, "gridSubdivisions", 1, 16, 1).name(t("videoView.gridSubdivisions.label")).listen().onChange(() => {
            setRenderOne(true);
        }).tooltip(t("videoView.gridSubdivisions.tooltip"));

        gridFolder.add(gridOverlay, "gridXOffset", 0,127,0.1).name(t("videoView.gridXOffset.label")).listen().onChange(() => {
            setRenderOne(true);
        }).tooltip(t("videoView.gridXOffset.tooltip"));

        gridFolder.add(gridOverlay, "gridYOffset",0,127,0.1).name(t("videoView.gridYOffset.label")).listen().onChange(() => {
            setRenderOne(true);
        }).tooltip(t("videoView.gridYOffset.tooltip"));

        gridFolder.addColor(gridOverlay, "gridColor").name(t("videoView.gridColor.label")).listen().onChange(() => {
            setRenderOne(true);
        }).tooltip(t("videoView.gridColor.tooltip"));
    }

}

const CONVOLUTION_KERNELS = {
    none: { kernel: null, divisor: 1, offset: 0 },
    sharpen: {
        kernel: [
            0, -1, 0,
            -1, 5, -1,
            0, -1, 0
        ],
        divisor: 1,
        offset: 0
    },
    edgeDetect: {
        kernel: [
            -1, -1, -1,
            -1, 8, -1,
            -1, -1, -1
        ],
        divisor: 1,
        offset: 0
    },
    emboss: {
        kernel: [
            -2, -1, 0,
            -1, 1, 1,
            0, 1, 2
        ],
        divisor: 1,
        offset: 128
    }
};

export function applyConvolution(ctx, width, height, kernelName, params = {}) {
    if (kernelName === 'none' || !CONVOLUTION_KERNELS[kernelName]) return;

    let { kernel, divisor, offset } = CONVOLUTION_KERNELS[kernelName];
    if (!kernel) return;

    const amount = params.amount ?? 1;
    const threshold = params.threshold ?? 0;
    const strength = params.strength ?? 1;
    const isEdgeDetect = kernelName === 'edgeDetect';

    if (kernelName === 'sharpen') {
        kernel = [
            0, -1 * amount, 0,
            -1 * amount, 1 + 4 * amount, -1 * amount,
            0, -1 * amount, 0
        ];
        divisor = 1;
    } else if (kernelName === 'emboss') {
        const d = strength;
        kernel = [
            -2 * d, -1 * d, 0,
            -1 * d, 1 * d, 1 * d,
            0, 1 * d, 2 * d
        ];
        divisor = 1;
        offset = 128;
    }

    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const output = new Uint8ClampedArray(data);

    const w = width;
    const h = height;

    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            for (let c = 0; c < 3; c++) {
                let sum = 0;
                for (let ky = -1; ky <= 1; ky++) {
                    for (let kx = -1; kx <= 1; kx++) {
                        const px = x + kx;
                        const py = y + ky;
                        const idx = (py * w + px) * 4 + c;
                        const kidx = (ky + 1) * 3 + (kx + 1);
                        sum += data[idx] * kernel[kidx];
                    }
                }
                const val = sum / divisor + offset;
                if (isEdgeDetect) {
                    output[(y * w + x) * 4 + c] = val > threshold ? 255 : 0;
                } else {
                    output[(y * w + x) * 4 + c] = Math.min(255, Math.max(0, val));
                }
            }
        }
    }

    ctx.putImageData(new ImageData(output, width, height), 0, 0);
}

// `store` false means "use these pixels for this pass, but do not remember them".
// The cache is keyed by frame number alone, so a wrong entry is served forever.
// getFrameImage is called only on a miss: for a past frame it draws a full-size
// stabilized canvas, which playback must not pay for every frame in the window.
// Returns null when there is no image.
function getOrCachePixelData(videoView, getFrameImage, frame, width, height, store = true) {
    if (!videoView._echoPixelCache) {
        videoView._echoPixelCache = new Map();
    }

    const cached = videoView._echoPixelCache.get(frame);
    if (cached && cached.length === width * height * 4) {
        return cached;
    }

    const frameImage = getFrameImage();
    if (!frameImage || frameImage.width === 0) return null;

    const tmpCtx = videoView._echoTmpCtx;
    tmpCtx.drawImage(frameImage, 0, 0, width, height);
    const data = tmpCtx.getImageData(0, 0, width, height).data;
    if (store) videoView._echoPixelCache.set(frame, data);
    return data;
}

function pruneEchoPixelCache(videoView, startFrame, endFrame) {
    if (!videoView._echoPixelCache) return;
    for (const key of videoView._echoPixelCache.keys()) {
        if (key < startFrame || key > endFrame) {
            videoView._echoPixelCache.delete(key);
        }
    }
}

export function clearEchoCache(videoView) {
    if (videoView._echoPixelCache) {
        videoView._echoPixelCache.clear();
    }
    videoView._lastEchoFrame = undefined;
    videoView._lastEchoResult = undefined;
    videoView._lastEchoWantMin = undefined;
    videoView._lastEchoWantMax = undefined;
    videoView._lastEchoNumFrames = undefined;
}

export function applyEchoEffect(videoView, currentImage, currentFrame, wantMin, wantMax) {
    // getImage() hands back a BLANK frame when the requested one has not decoded
    // yet (CVideoWebCodecBase.getImage's last resort). A blank frame is full-size
    // and black, so the `width === 0` guard below never sees it — and both the
    // pixel cache and the result memo are keyed by FRAME NUMBER with no notion of
    // "that frame wasn't real". Remembering one black pass therefore made the
    // frame permanently black, which is exactly what a Make Video swap produced:
    // the new video decodes nothing for a moment, and the echo froze on it.
    // getCachedImage() is null unless the frame genuinely decoded.
    const currentDecoded = videoView.videoData?.getCachedImage?.(currentFrame) != null;

    const numEchoFrames = Math.round(videoView.in.echoFrames?.v0 ?? 10);
    const startFrame = Math.max(0, currentFrame - numEchoFrames + 1);
    const width = currentImage.width;
    const height = currentImage.height;

    if (!videoView._echoCanvas || videoView._echoCanvas.width !== width || videoView._echoCanvas.height !== height) {
        videoView._echoCanvas = document.createElement('canvas');
        videoView._echoCanvas.width = width;
        videoView._echoCanvas.height = height;
        videoView._echoCtx = videoView._echoCanvas.getContext('2d', { willReadFrequently: true });
        videoView._echoProvisionalCanvas = document.createElement('canvas');
        videoView._echoProvisionalCanvas.width = width;
        videoView._echoProvisionalCanvas.height = height;
        videoView._echoProvisionalCtx = videoView._echoProvisionalCanvas.getContext('2d', { willReadFrequently: true });
        videoView._echoTmpCanvas = document.createElement('canvas');
        videoView._echoTmpCanvas.width = width;
        videoView._echoTmpCanvas.height = height;
        videoView._echoTmpCtx = videoView._echoTmpCanvas.getContext('2d', { willReadFrequently: true });
        clearEchoCache(videoView);
    }

    if (videoView._lastEchoFrame === currentFrame &&
        videoView._lastEchoWantMin === wantMin &&
        videoView._lastEchoWantMax === wantMax &&
        videoView._lastEchoNumFrames === numEchoFrames &&
        videoView._lastEchoResult) {
        return videoView._lastEchoResult;
    }

    // A provisional result (current frame not decoded yet) goes to its own canvas.
    // The stages after Echo (Levels, Curves, Tonal, Invert) cache on the IDENTITY
    // of their input canvas plus the frame number. If the final result went into
    // the same canvas as the provisional one, at the same frame, they kept serving
    // their copy of the provisional picture: a black video view after every load.
    const echoCanvas = currentDecoded ? videoView._echoCanvas : videoView._echoProvisionalCanvas;
    const echoCtx = currentDecoded ? videoView._echoCtx : videoView._echoProvisionalCtx;

    const pixelCount = width * height * 4;
    const minPixels = wantMin ? new Uint8ClampedArray(pixelCount) : null;
    const maxPixels = wantMax ? new Uint8ClampedArray(pixelCount) : null;
    const sumPixels = (wantMin && wantMax) ? new Float32Array(pixelCount) : null;
    let frameCount = 0;
    let initialized = false;

    for (let f = startFrame; f <= currentFrame; f++) {
        const isCurrent = f === currentFrame;
        // currentImage came from getImage(), so it carries the stabilization
        // shift. getCachedImage() is the RAW decoded frame: use it only to ask
        // whether frame f decoded, never for its pixels, or Echo combines one
        // stabilized frame with unstabilized ones and the trail is the shake.
        if (!isCurrent && !videoView.videoData.getCachedImage(f)) continue;

        const frameData = getOrCachePixelData(videoView,
            () => isCurrent ? currentImage : videoView.videoData.getCachedStabilizedImage(f),
            f, width, height, !isCurrent || currentDecoded);
        if (!frameData) continue;

        if (!initialized) {
            if (minPixels) minPixels.set(frameData);
            if (maxPixels) maxPixels.set(frameData);
            if (sumPixels) { for (let i = 0; i < pixelCount; i++) sumPixels[i] = frameData[i]; }
            initialized = true;
        } else {
            for (let i = 0; i < pixelCount; i += 4) {
                for (let c = 0; c < 3; c++) {
                    const idx = i + c;
                    const val = frameData[idx];
                    if (minPixels && val < minPixels[idx]) minPixels[idx] = val;
                    if (maxPixels && val > maxPixels[idx]) maxPixels[idx] = val;
                    if (sumPixels) sumPixels[idx] += val;
                }
                if (minPixels) minPixels[i + 3] = 255;
                if (maxPixels) maxPixels[i + 3] = 255;
            }
        }
        frameCount++;
    }

    pruneEchoPixelCache(videoView, startFrame, currentFrame);

    if (!initialized) return currentImage;

    let resultPixels;
    if (wantMin && wantMax) {
        resultPixels = new Uint8ClampedArray(pixelCount);
        for (let i = 0; i < pixelCount; i += 4) {
            for (let c = 0; c < 3; c++) {
                const idx = i + c;
                const avg = sumPixels[idx] / frameCount;
                const minDev = Math.abs(minPixels[idx] - avg);
                const maxDev = Math.abs(maxPixels[idx] - avg);
                resultPixels[idx] = (maxDev >= minDev) ? maxPixels[idx] : minPixels[idx];
            }
            resultPixels[i + 3] = 255;
        }
    } else if (wantMin) {
        resultPixels = minPixels;
    } else {
        resultPixels = maxPixels;
    }

    const outputData = new ImageData(resultPixels, width, height);
    echoCtx.putImageData(outputData, 0, 0);

    if (currentDecoded) {
        videoView._lastEchoFrame = currentFrame;
        videoView._lastEchoWantMin = wantMin;
        videoView._lastEchoWantMax = wantMax;
        videoView._lastEchoNumFrames = numEchoFrames;
        videoView._lastEchoResult = echoCanvas;
    } else {
        // Provisional: show it, but recompute next render, once the frame is real.
        videoView._lastEchoFrame = undefined;
        videoView._lastEchoResult = undefined;
    }

    return echoCanvas;
}

export function applyConvolutionToImage(image, kernelName, params, videoView, frame = undefined) {
    if (kernelName === 'none' || !CONVOLUTION_KERNELS[kernelName]) return image;

    // Skip recalculation if the source image, frame, kernel, and params are unchanged.
    // The frame check is essential: during playback the decoder reuses the same image
    // object across frames, so identity alone would return a stale cached result.
    if (videoView._convolutionCanvas &&
        videoView._convLastImage === image &&
        videoView._convLastFrame === frame &&
        videoView._convLastKernel === kernelName &&
        videoView._convLastAmount === params.amount &&
        videoView._convLastThreshold === params.threshold &&
        videoView._convLastStrength === params.strength) {
        return videoView._convolutionCanvas;
    }

    const width = image.width;
    const height = image.height;

    if (!videoView._convolutionCanvas ||
        videoView._convolutionCanvas.width !== width ||
        videoView._convolutionCanvas.height !== height) {
        videoView._convolutionCanvas = document.createElement('canvas');
        videoView._convolutionCanvas.width = width;
        videoView._convolutionCanvas.height = height;
        videoView._convolutionCtx = videoView._convolutionCanvas.getContext('2d');
    }

    const ctx = videoView._convolutionCtx;
    ctx.drawImage(image, 0, 0);
    applyConvolution(ctx, width, height, kernelName, params);

    videoView._convLastImage = image;
    videoView._convLastFrame = frame;
    videoView._convLastKernel = kernelName;
    videoView._convLastAmount = params.amount;
    videoView._convLastThreshold = params.threshold;
    videoView._convLastStrength = params.strength;

    return videoView._convolutionCanvas;
}

export function applySourcePixelFilterToImage(image, filterString, videoView) {
    if (!filterString || filterString === 'none') return image;

    const width = image.width;
    const height = image.height;

    if (!videoView._sourceFilterCanvas ||
        videoView._sourceFilterCanvas.width !== width ||
        videoView._sourceFilterCanvas.height !== height) {
        videoView._sourceFilterCanvas = document.createElement('canvas');
        videoView._sourceFilterCanvas.width = width;
        videoView._sourceFilterCanvas.height = height;
        videoView._sourceFilterCtx = videoView._sourceFilterCanvas.getContext('2d');
    }

    const ctx = videoView._sourceFilterCtx;
    ctx.clearRect(0, 0, width, height);
    ctx.filter = filterString;
    ctx.drawImage(image, 0, 0, width, height);
    ctx.filter = 'none';
    return videoView._sourceFilterCanvas;
}

export function hasActiveTonalAdjustments({
    shadows = 0,
    highlights = 0,
    dehaze = 0,
} = {}) {
    return shadows !== 0 || highlights !== 0 || dehaze !== 0;
}

export function tonalRegionWeight(luma, center, width = TONAL_REGION_WIDTH) {
    const x = Math.max(0, Math.min(1, luma));
    const endpointFade = Math.sin(Math.PI * x);
    const distance = Math.abs(x - center) / width;
    const region = Math.max(0, 1 - distance * distance);
    return endpointFade * region * region;
}

export function applyTonalAdjustmentToPixel(r, g, b, {
    shadows = 0,
    highlights = 0,
    dehaze = 0,
} = {}) {
    if (!hasActiveTonalAdjustments({shadows, highlights, dehaze})) {
        return [r, g, b];
    }

    let outR = r;
    let outG = g;
    let outB = b;
    const luma = getLuma(r, g, b) / 255;
    const shadowAmount = Math.max(-1, Math.min(1, shadows / 100));
    const highlightAmount = Math.max(-1, Math.min(1, highlights / 100));

    if (shadowAmount !== 0) {
        const mask = tonalRegionWeight(luma, 0.1);
        if (shadowAmount > 0) {
            outR += (255 - outR) * shadowAmount * mask;
            outG += (255 - outG) * shadowAmount * mask;
            outB += (255 - outB) * shadowAmount * mask;
        } else {
            outR += outR * shadowAmount * mask;
            outG += outG * shadowAmount * mask;
            outB += outB * shadowAmount * mask;
        }
    }

    if (highlightAmount !== 0) {
        const mask = tonalRegionWeight(luma, 0.9);
        if (highlightAmount > 0) {
            outR += (255 - outR) * highlightAmount * mask;
            outG += (255 - outG) * highlightAmount * mask;
            outB += (255 - outB) * highlightAmount * mask;
        } else {
            outR += outR * highlightAmount * mask;
            outG += outG * highlightAmount * mask;
            outB += outB * highlightAmount * mask;
        }
    }

    const dehazeAmount = Math.max(-1, Math.min(1, dehaze / 100));
    if (dehazeAmount !== 0) {
        const airlight = 220;
        if (dehazeAmount > 0) {
            const contrast = 1 + 0.75 * dehazeAmount;
            outR = airlight + (outR - airlight) * contrast;
            outG = airlight + (outG - airlight) * contrast;
            outB = airlight + (outB - airlight) * contrast;
            const adjustedLuma = getLuma(outR, outG, outB);
            const saturation = 1 + 0.25 * dehazeAmount;
            outR = adjustedLuma + (outR - adjustedLuma) * saturation;
            outG = adjustedLuma + (outG - adjustedLuma) * saturation;
            outB = adjustedLuma + (outB - adjustedLuma) * saturation;
        } else {
            const haze = -dehazeAmount * 0.45;
            outR = outR * (1 - haze) + airlight * haze;
            outG = outG * (1 - haze) + airlight * haze;
            outB = outB * (1 - haze) + airlight * haze;
            const hazyLuma = getLuma(outR, outG, outB);
            const saturation = 1 + dehazeAmount * 0.3;
            outR = hazyLuma + (outR - hazyLuma) * saturation;
            outG = hazyLuma + (outG - hazyLuma) * saturation;
            outB = hazyLuma + (outB - hazyLuma) * saturation;
        }
    }

    return [clampByte(outR), clampByte(outG), clampByte(outB)];
}

function clampTonalAmount(value) {
    return Math.max(-1, Math.min(1, (value ?? 0) / 100));
}

function applyTonalRegionLoop(data, amount, center) {
    const target = amount > 0 ? 255 : 0;
    const strength = Math.abs(amount);
    const length = data.length;

    // All slider-dependent values are fixed above this point. The loop only
    // does per-pixel luma/mask math, then moves each channel toward its target.
    for (let i = 0; i < length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        let lumaByte = TONAL_LUMA_R * r + TONAL_LUMA_G * g + TONAL_LUMA_B * b;
        if (lumaByte <= 0) lumaByte = 0;
        else if (lumaByte >= 255) lumaByte = 255;
        else lumaByte = Math.round(lumaByte);
        const luma = lumaByte / 255;
        const distance = Math.abs(luma - center) * TONAL_REGION_INV_WIDTH;
        const region = 1 - distance * distance;

        if (region > 0) {
            const mask = Math.sin(TONAL_ENDPOINT_PI * luma) * region * region * strength;
            data[i] = r + (target - r) * mask;
            data[i + 1] = g + (target - g) * mask;
            data[i + 2] = b + (target - b) * mask;
        }
    }
}

function applyShadowHighlightRegionLoop(data, shadowAmount, highlightAmount) {
    const shadowTarget = shadowAmount > 0 ? 255 : 0;
    const highlightTarget = highlightAmount > 0 ? 255 : 0;
    const shadowStrength = Math.abs(shadowAmount);
    const highlightStrength = Math.abs(highlightAmount);
    const length = data.length;

    // Shadows and highlights both key from the original pixel luma. Keeping
    // them in one loop preserves that relationship while avoiding two luma
    // calculations and two full image passes when both sliders are active.
    for (let i = 0; i < length; i += 4) {
        let r = data[i];
        let g = data[i + 1];
        let b = data[i + 2];
        let lumaByte = TONAL_LUMA_R * r + TONAL_LUMA_G * g + TONAL_LUMA_B * b;
        if (lumaByte <= 0) lumaByte = 0;
        else if (lumaByte >= 255) lumaByte = 255;
        else lumaByte = Math.round(lumaByte);
        const luma = lumaByte / 255;

        let distance = Math.abs(luma - 0.1) * TONAL_REGION_INV_WIDTH;
        let region = 1 - distance * distance;
        if (region > 0) {
            const mask = Math.sin(TONAL_ENDPOINT_PI * luma) * region * region * shadowStrength;
            r += (shadowTarget - r) * mask;
            g += (shadowTarget - g) * mask;
            b += (shadowTarget - b) * mask;
        }

        distance = Math.abs(luma - 0.9) * TONAL_REGION_INV_WIDTH;
        region = 1 - distance * distance;
        if (region > 0) {
            const mask = Math.sin(TONAL_ENDPOINT_PI * luma) * region * region * highlightStrength;
            r += (highlightTarget - r) * mask;
            g += (highlightTarget - g) * mask;
            b += (highlightTarget - b) * mask;
        }

        data[i] = r;
        data[i + 1] = g;
        data[i + 2] = b;
    }
}

function applyTonalRegionToFloatLoop(data, out, amount, center) {
    const target = amount > 0 ? 255 : 0;
    const strength = Math.abs(amount);
    const length = data.length;

    // Float-output variant for the "region adjustment then dehaze" pipeline.
    // It preserves the old single final clamp without putting sign/slider
    // checks inside the pixel loop.
    for (let i = 0; i < length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        let lumaByte = TONAL_LUMA_R * r + TONAL_LUMA_G * g + TONAL_LUMA_B * b;
        if (lumaByte <= 0) lumaByte = 0;
        else if (lumaByte >= 255) lumaByte = 255;
        else lumaByte = Math.round(lumaByte);
        const luma = lumaByte / 255;
        const distance = Math.abs(luma - center) * TONAL_REGION_INV_WIDTH;
        const region = 1 - distance * distance;

        if (region > 0) {
            const mask = Math.sin(TONAL_ENDPOINT_PI * luma) * region * region * strength;
            out[i] = r + (target - r) * mask;
            out[i + 1] = g + (target - g) * mask;
            out[i + 2] = b + (target - b) * mask;
        } else {
            out[i] = r;
            out[i + 1] = g;
            out[i + 2] = b;
        }
    }
}

function applyShadowHighlightRegionToFloatLoop(data, out, shadowAmount, highlightAmount) {
    const shadowTarget = shadowAmount > 0 ? 255 : 0;
    const highlightTarget = highlightAmount > 0 ? 255 : 0;
    const shadowStrength = Math.abs(shadowAmount);
    const highlightStrength = Math.abs(highlightAmount);
    const length = data.length;

    // This variant is used only when dehaze follows. It keeps the intermediate
    // shadow/highlight result in float storage so ImageData's Uint8ClampedArray
    // does not round/clamp before the dehaze math; the old helper also clamped
    // only once at the very end.
    for (let i = 0; i < length; i += 4) {
        let r = data[i];
        let g = data[i + 1];
        let b = data[i + 2];
        let lumaByte = TONAL_LUMA_R * r + TONAL_LUMA_G * g + TONAL_LUMA_B * b;
        if (lumaByte <= 0) lumaByte = 0;
        else if (lumaByte >= 255) lumaByte = 255;
        else lumaByte = Math.round(lumaByte);
        const luma = lumaByte / 255;

        let distance = Math.abs(luma - 0.1) * TONAL_REGION_INV_WIDTH;
        let region = 1 - distance * distance;
        if (region > 0) {
            const mask = Math.sin(TONAL_ENDPOINT_PI * luma) * region * region * shadowStrength;
            r += (shadowTarget - r) * mask;
            g += (shadowTarget - g) * mask;
            b += (shadowTarget - b) * mask;
        }

        distance = Math.abs(luma - 0.9) * TONAL_REGION_INV_WIDTH;
        region = 1 - distance * distance;
        if (region > 0) {
            const mask = Math.sin(TONAL_ENDPOINT_PI * luma) * region * region * highlightStrength;
            r += (highlightTarget - r) * mask;
            g += (highlightTarget - g) * mask;
            b += (highlightTarget - b) * mask;
        }

        out[i] = r;
        out[i + 1] = g;
        out[i + 2] = b;
    }
}

function applyPositiveDehazeLoop(data, amount) {
    const airlight = 220;
    const contrast = 1 + 0.75 * amount;
    const saturation = 1 + 0.25 * amount;
    const length = data.length;

    // Dehaze has a different formula for positive values, so the caller
    // dispatches here once instead of checking the sign for every pixel.
    for (let i = 0; i < length; i += 4) {
        let r = airlight + (data[i] - airlight) * contrast;
        let g = airlight + (data[i + 1] - airlight) * contrast;
        let b = airlight + (data[i + 2] - airlight) * contrast;
        let luma = TONAL_LUMA_R * r + TONAL_LUMA_G * g + TONAL_LUMA_B * b;
        if (luma <= 0) luma = 0;
        else if (luma >= 255) luma = 255;
        else luma = Math.round(luma);

        data[i] = luma + (r - luma) * saturation;
        data[i + 1] = luma + (g - luma) * saturation;
        data[i + 2] = luma + (b - luma) * saturation;
    }
}

function applyNegativeDehazeLoop(data, amount) {
    const airlight = 220;
    const haze = -amount * 0.45;
    const imageWeight = 1 - haze;
    const saturation = 1 + amount * 0.3;
    const length = data.length;

    // Negative dehaze adds haze and desaturates. Its constants are invariant
    // for the frame, so this loop contains only the arithmetic that varies by
    // pixel/channel.
    for (let i = 0; i < length; i += 4) {
        let r = data[i] * imageWeight + airlight * haze;
        let g = data[i + 1] * imageWeight + airlight * haze;
        let b = data[i + 2] * imageWeight + airlight * haze;
        let luma = TONAL_LUMA_R * r + TONAL_LUMA_G * g + TONAL_LUMA_B * b;
        if (luma <= 0) luma = 0;
        else if (luma >= 255) luma = 255;
        else luma = Math.round(luma);

        data[i] = luma + (r - luma) * saturation;
        data[i + 1] = luma + (g - luma) * saturation;
        data[i + 2] = luma + (b - luma) * saturation;
    }
}

function applyPositiveDehazeFromFloatLoop(source, data, amount) {
    const airlight = 220;
    const contrast = 1 + 0.75 * amount;
    const saturation = 1 + 0.25 * amount;
    const length = data.length;

    for (let i = 0; i < length; i += 4) {
        let r = airlight + (source[i] - airlight) * contrast;
        let g = airlight + (source[i + 1] - airlight) * contrast;
        let b = airlight + (source[i + 2] - airlight) * contrast;
        let luma = TONAL_LUMA_R * r + TONAL_LUMA_G * g + TONAL_LUMA_B * b;
        if (luma <= 0) luma = 0;
        else if (luma >= 255) luma = 255;
        else luma = Math.round(luma);

        data[i] = luma + (r - luma) * saturation;
        data[i + 1] = luma + (g - luma) * saturation;
        data[i + 2] = luma + (b - luma) * saturation;
    }
}

function applyNegativeDehazeFromFloatLoop(source, data, amount) {
    const airlight = 220;
    const haze = -amount * 0.45;
    const imageWeight = 1 - haze;
    const saturation = 1 + amount * 0.3;
    const length = data.length;

    for (let i = 0; i < length; i += 4) {
        let r = source[i] * imageWeight + airlight * haze;
        let g = source[i + 1] * imageWeight + airlight * haze;
        let b = source[i + 2] * imageWeight + airlight * haze;
        let luma = TONAL_LUMA_R * r + TONAL_LUMA_G * g + TONAL_LUMA_B * b;
        if (luma <= 0) luma = 0;
        else if (luma >= 255) luma = 255;
        else luma = Math.round(luma);

        data[i] = luma + (r - luma) * saturation;
        data[i + 1] = luma + (g - luma) * saturation;
        data[i + 2] = luma + (b - luma) * saturation;
    }
}

export function applyTonalAdjustmentsToImage(image, settings, videoView, frame = undefined) {
    if (!hasActiveTonalAdjustments(settings)) return image;

    const width = image.width;
    const height = image.height;

    if (!videoView._tonalAdjustCanvas ||
        videoView._tonalAdjustCanvas.width !== width ||
        videoView._tonalAdjustCanvas.height !== height) {
        videoView._tonalAdjustCanvas = document.createElement('canvas');
        videoView._tonalAdjustCanvas.width = width;
        videoView._tonalAdjustCanvas.height = height;
        videoView._tonalAdjustCtx = videoView._tonalAdjustCanvas.getContext('2d', {willReadFrequently: true});
        videoView._tonalAdjustLastImage = undefined;
        videoView._tonalAdjustLastFrame = undefined;
        videoView._tonalAdjustLastKey = undefined;
    }

    const key = `${settings.shadows ?? 0}:${settings.highlights ?? 0}:${settings.dehaze ?? 0}`;
    if (videoView._tonalAdjustLastImage === image &&
        videoView._tonalAdjustLastFrame === frame &&
        videoView._tonalAdjustLastKey === key) {
        return videoView._tonalAdjustCanvas;
    }

    const ctx = videoView._tonalAdjustCtx;
    ctx.drawImage(image, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const shadows = clampTonalAmount(settings?.shadows);
    const highlights = clampTonalAmount(settings?.highlights);
    const dehaze = clampTonalAmount(settings?.dehaze);
    const hasRegionAdjustment = shadows !== 0 || highlights !== 0;

    // Dispatch once per active control. The old path called
    // applyTonalAdjustmentToPixel() for every pixel, repeatedly normalizing the
    // same slider values and branching over all three adjustment families.
    if (dehaze !== 0 && hasRegionAdjustment) {
        const length = data.length;
        if (!videoView._tonalAdjustFloatBuffer || videoView._tonalAdjustFloatBuffer.length !== length) {
            videoView._tonalAdjustFloatBuffer = new Float32Array(length);
        }

        const tonalFloats = videoView._tonalAdjustFloatBuffer;
        if (shadows !== 0 && highlights !== 0) {
            applyShadowHighlightRegionToFloatLoop(data, tonalFloats, shadows, highlights);
        } else if (shadows !== 0) {
            applyTonalRegionToFloatLoop(data, tonalFloats, shadows, 0.1);
        } else {
            applyTonalRegionToFloatLoop(data, tonalFloats, highlights, 0.9);
        }
        if (dehaze > 0) {
            applyPositiveDehazeFromFloatLoop(tonalFloats, data, dehaze);
        } else {
            applyNegativeDehazeFromFloatLoop(tonalFloats, data, dehaze);
        }
    } else {
        if (shadows !== 0 && highlights !== 0) {
            applyShadowHighlightRegionLoop(data, shadows, highlights);
        } else if (shadows !== 0) {
            applyTonalRegionLoop(data, shadows, 0.1);
        } else if (highlights !== 0) {
            applyTonalRegionLoop(data, highlights, 0.9);
        }

        if (dehaze > 0) {
            applyPositiveDehazeLoop(data, dehaze);
        } else if (dehaze < 0) {
            applyNegativeDehazeLoop(data, dehaze);
        }
    }

    ctx.putImageData(imageData, 0, 0);

    videoView._tonalAdjustLastImage = image;
    videoView._tonalAdjustLastFrame = frame;
    videoView._tonalAdjustLastKey = key;

    return videoView._tonalAdjustCanvas;
}

export function buildLevelsLUT({
    inputBlack = 0,
    inputWhite = 255,
    midpoint = 1,
    outputBlack = 0,
    outputWhite = 255,
} = {}) {
    const lut = new Uint8ClampedArray(256);
    const inBlack = Math.max(0, Math.min(254, Math.round(inputBlack)));
    const inWhite = Math.max(inBlack + 1, Math.min(255, Math.round(inputWhite)));
    const outBlack = Math.max(0, Math.min(255, Math.round(outputBlack)));
    const outWhite = Math.max(0, Math.min(255, Math.round(outputWhite)));
    const gamma = 1 / Math.max(0.01, Math.min(9.99, midpoint || 1));
    const inputRange = inWhite - inBlack;
    const outputRange = outWhite - outBlack;

    for (let i = 0; i < 256; i++) {
        const normalized = Math.max(0, Math.min(1, (i - inBlack) / inputRange));
        lut[i] = Math.round(outBlack + Math.pow(normalized, gamma) * outputRange);
    }
    return lut;
}

export function areLevelsDefault(levels = {}) {
    return (levels.inputBlack ?? 0) === 0 &&
        (levels.inputWhite ?? 255) === 255 &&
        (levels.midpoint ?? 1) === 1 &&
        (levels.outputBlack ?? 0) === 0 &&
        (levels.outputWhite ?? 255) === 255;
}

// Photoshop-style Levels: input black/white remap, midpoint gamma, output black/white remap.
// Uses a cached 256-entry LUT to skip 4M+ Math.pow calls per HD frame.
export function applyLevelsToImage(image, levels, videoView, frame = undefined) {
    if (areLevelsDefault(levels)) return image;

    const width = image.width;
    const height = image.height;

    if (!videoView._levelsMidpointCanvas ||
        videoView._levelsMidpointCanvas.width !== width ||
        videoView._levelsMidpointCanvas.height !== height) {
        videoView._levelsMidpointCanvas = document.createElement('canvas');
        videoView._levelsMidpointCanvas.width = width;
        videoView._levelsMidpointCanvas.height = height;
        videoView._levelsMidpointCtx = videoView._levelsMidpointCanvas.getContext('2d', { willReadFrequently: true });
        videoView._levelsLastMidpoint = undefined;
        videoView._levelsLastImage = undefined;
        videoView._levelsMidpointLUT = null;
    }

    const key = [
        levels.inputBlack ?? 0,
        levels.inputWhite ?? 255,
        levels.midpoint ?? 1,
        levels.outputBlack ?? 0,
        levels.outputWhite ?? 255,
    ].join(":");

    if (videoView._levelsLastImage === image && videoView._levelsLastFrame === frame && videoView._levelsLastKey === key) {
        return videoView._levelsMidpointCanvas;
    }

    if (videoView._levelsMidpointLUT === null || videoView._levelsLastKey !== key) {
        videoView._levelsMidpointLUT = buildLevelsLUT(levels);
    }

    const ctx = videoView._levelsMidpointCtx;
    ctx.drawImage(image, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const lut = videoView._levelsMidpointLUT;
    const length = data.length;

    for (let i = 0; i < length; i += 4) {
        data[i] = lut[data[i]];
        data[i + 1] = lut[data[i + 1]];
        data[i + 2] = lut[data[i + 2]];
    }

    ctx.putImageData(imageData, 0, 0);

    videoView._levelsLastImage = image;
    videoView._levelsLastFrame = frame;
    videoView._levelsLastKey = key;

    return videoView._levelsMidpointCanvas;
}

export function applyLevelsMidpointToImage(image, midpoint, videoView) {
    return applyLevelsToImage(image, {midpoint}, videoView);
}

export function applyByteInvertToImage(image, videoView, frame = undefined, sourceKey = "") {
    if (!image) return image;

    const width = image.width;
    const height = image.height;

    if (!videoView._invertCanvas ||
        videoView._invertCanvas.width !== width ||
        videoView._invertCanvas.height !== height) {
        videoView._invertCanvas = document.createElement('canvas');
        videoView._invertCanvas.width = width;
        videoView._invertCanvas.height = height;
        videoView._invertCtx = videoView._invertCanvas.getContext('2d', {willReadFrequently: true});
        videoView._invertLastImage = undefined;
        videoView._invertLastFrame = undefined;
        videoView._invertLastSourceKey = undefined;
    }

    if (videoView._invertLastImage === image &&
        videoView._invertLastFrame === frame &&
        videoView._invertLastSourceKey === sourceKey) {
        return videoView._invertCanvas;
    }

    const ctx = videoView._invertCtx;
    ctx.drawImage(image, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const length = data.length;

    for (let i = 0; i < length; i += 4) {
        data[i] = 255 - data[i];
        data[i + 1] = 255 - data[i + 1];
        data[i + 2] = 255 - data[i + 2];
    }

    ctx.putImageData(imageData, 0, 0);

    videoView._invertLastImage = image;
    videoView._invertLastFrame = frame;
    videoView._invertLastSourceKey = sourceKey;

    return videoView._invertCanvas;
}

export function applyCurvesToImage(image, lut, videoView, frame = undefined) {
    if (!lut) return image;

    const width = image.width;
    const height = image.height;

    if (!videoView._curvesCanvas ||
        videoView._curvesCanvas.width !== width ||
        videoView._curvesCanvas.height !== height) {
        videoView._curvesCanvas = document.createElement('canvas');
        videoView._curvesCanvas.width = width;
        videoView._curvesCanvas.height = height;
        videoView._curvesCtx = videoView._curvesCanvas.getContext('2d', {willReadFrequently: true});
        videoView._curvesLastImage = undefined;
        videoView._curvesLastFrame = undefined;
        videoView._curvesLastRevision = undefined;
    }

    const revision = videoView.curvesView?.curveRevision ?? 0;
    if (videoView._curvesLastImage === image &&
        videoView._curvesLastFrame === frame &&
        videoView._curvesLastRevision === revision) {
        return videoView._curvesCanvas;
    }

    const ctx = videoView._curvesCtx;
    ctx.drawImage(image, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const length = data.length;

    for (let i = 0; i < length; i += 4) {
        data[i] = lut[data[i]];
        data[i + 1] = lut[data[i + 1]];
        data[i + 2] = lut[data[i + 2]];
    }

    ctx.putImageData(imageData, 0, 0);

    videoView._curvesLastImage = image;
    videoView._curvesLastFrame = frame;
    videoView._curvesLastRevision = revision;

    return videoView._curvesCanvas;
}

export function getClipComparisonValue(originalValue, invertActive = false) {
    return invertActive ? 255 - originalValue : originalValue;
}

export function applyELAOutputExpansion(pixels, width, height, method, clipPercent) {
    switch (method) {
        case 'histogramEqualization':
            applyHistogramEqualization(pixels, width, height);
            break;
        case 'autoContrast':
            applyAutoContrast(pixels, width, height, clipPercent);
            break;
        case 'autoContrastChannels':
            applyAutoContrastChannels(pixels, width, height, clipPercent);
            break;
        case 'none':
        default:
            break;
    }
}

function applyHistogramEqualization(pixels, width, height) {
    const hist = buildLuminanceHistogram(pixels);
    const pixelCount = width * height;
    if (pixelCount <= 1) return;

    let cdf = 0;
    let cdfMin = -1;
    const lut = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        cdf += hist[i];
        if (cdfMin < 0 && cdf > 0) {
            cdfMin = cdf;
        }
        if (cdfMin < 0 || cdf === cdfMin) {
            lut[i] = 0;
        } else {
            lut[i] = clampByte(((cdf - cdfMin) * 255) / (pixelCount - cdfMin));
        }
    }

    for (let i = 0; i < pixels.length; i += 4) {
        const r = pixels[i];
        const g = pixels[i + 1];
        const b = pixels[i + 2];
        const luma = getLuma(r, g, b);
        const newLuma = lut[luma];
        if (luma <= 0) {
            pixels[i] = newLuma;
            pixels[i + 1] = newLuma;
            pixels[i + 2] = newLuma;
            continue;
        }
        const scale = newLuma / luma;
        pixels[i] = clampByte(r * scale);
        pixels[i + 1] = clampByte(g * scale);
        pixels[i + 2] = clampByte(b * scale);
    }
}

function applyAutoContrast(pixels, width, height, clipPercent) {
    const hist = buildLuminanceHistogram(pixels);
    const pixelCount = width * height;
    const { low, high } = findLowHighFromHistogram(hist, pixelCount, clipPercent);
    if (high <= low) return;

    const range = high - low;
    for (let i = 0; i < pixels.length; i += 4) {
        pixels[i] = clampByte(((pixels[i] - low) * 255) / range);
        pixels[i + 1] = clampByte(((pixels[i + 1] - low) * 255) / range);
        pixels[i + 2] = clampByte(((pixels[i + 2] - low) * 255) / range);
    }
}

function applyAutoContrastChannels(pixels, width, height, clipPercent) {
    const pixelCount = width * height;
    const channelRanges = [];

    for (let c = 0; c < 3; c++) {
        const hist = new Uint32Array(256);
        for (let i = c; i < pixels.length; i += 4) {
            hist[pixels[i]]++;
        }
        channelRanges[c] = findLowHighFromHistogram(hist, pixelCount, clipPercent);
    }

    for (let i = 0; i < pixels.length; i += 4) {
        for (let c = 0; c < 3; c++) {
            const { low, high } = channelRanges[c];
            if (high <= low) continue;
            pixels[i + c] = clampByte(((pixels[i + c] - low) * 255) / (high - low));
        }
    }
}

function buildLuminanceHistogram(pixels) {
    const hist = new Uint32Array(256);
    for (let i = 0; i < pixels.length; i += 4) {
        const luma = getLuma(pixels[i], pixels[i + 1], pixels[i + 2]);
        hist[luma]++;
    }
    return hist;
}

function findLowHighFromHistogram(hist, sampleCount, clipPercent = 0) {
    const clipCount = Math.floor(sampleCount * Math.max(0, clipPercent) / 100);

    let low = 0;
    let cumulativeLow = 0;
    while (low < 255 && cumulativeLow + hist[low] <= clipCount) {
        cumulativeLow += hist[low];
        low++;
    }

    let high = 255;
    let cumulativeHigh = 0;
    while (high > 0 && cumulativeHigh + hist[high] <= clipCount) {
        cumulativeHigh += hist[high];
        high--;
    }

    return { low, high };
}

function getLuma(r, g, b) {
    return clampByte(0.299 * r + 0.587 * g + 0.114 * b);
}

export function clampByte(value) {
    if (value <= 0) return 0;
    if (value >= 255) return 255;
    return Math.round(value);
}

/**
 * Map a noise ratio to a color on a blue → green → yellow → red gradient.
 * ratio < 0.5: deep blue (unusually low noise)
 * ratio ≈ 1.0: green (consistent with median)
 * ratio > 2.0: red (unusually high noise)
 */
export function noiseRatioToColor(ratio) {
    const t = Math.max(0, Math.min(1, (ratio - 0.25) / 2.75));

    let r, g, b;
    if (t < 0.27) {
        // Blue to Cyan (ratio ~0.25 to ~1.0)
        const s = t / 0.27;
        r = 0;
        g = Math.round(s * 200);
        b = Math.round(200 - s * 100);
    } else if (t < 0.55) {
        // Cyan/Green to Yellow (ratio ~1.0 to ~1.75)
        const s = (t - 0.27) / 0.28;
        r = Math.round(s * 255);
        g = 200;
        b = Math.round(100 * (1 - s));
    } else {
        // Yellow to Red (ratio ~1.75 to ~3.0)
        const s = (t - 0.55) / 0.45;
        r = 255;
        g = Math.round(200 * (1 - s));
        b = 0;
    }

    return [r, g, b];
}

export function canvasToBlobAsync(canvas, type, quality) {
    return new Promise((resolve) => {
        if (canvas.toBlob) {
            canvas.toBlob(resolve, type, quality);
            return;
        }
        resolve(dataURLToBlob(canvas.toDataURL(type, quality)));
    });
}

export function decodeImageBlob(blob) {
    if (typeof createImageBitmap === "function") {
        return createImageBitmap(blob);
    }
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(blob);
        const img = new Image();
        img.onload = () => {
            URL.revokeObjectURL(url);
            resolve(img);
        };
        img.onerror = (err) => {
            URL.revokeObjectURL(url);
            reject(err);
        };
        img.src = url;
    });
}

function dataURLToBlob(dataURL) {
    const parts = dataURL.split(',');
    const mime = parts[0].match(/:(.*?);/)?.[1] || 'image/jpeg';
    const binary = atob(parts[1]);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return new Blob([bytes], { type: mime });
}
