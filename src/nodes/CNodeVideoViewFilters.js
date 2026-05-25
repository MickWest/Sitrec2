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

import {guiMenus, NodeMan, setRenderOne} from "../Globals";
import {t} from "../i18n";
import {CNodeGUIFlag, CNodeGUIValue} from "./CNodeGUIValue";
import {CNodeConstant} from "./CNode";
import {CNodeGridOverlay} from "./CNodeGridOverlay";
import {EventManager} from "../CEventManager";

// Top-level GUI folders are shared across CNodeVideoView instances — the first
// node through addFiltersToVideoNode creates them; the class methods in
// CNodeVideoView.js read them to gate ELA / noise overlay computation on their
// open/closed state. Exported as live bindings so importers see updates when
// addFiltersToVideoNode runs for the first node.
export let guiVideoEffectsFolder = null;
export let guiVideoProcessingFolder = null;
export let guiVideoForensicsFolder = null;
export let guiVideoELAFolder = null;
export let guiVideoNoiseFolder = null;

export function addFiltersToVideoNode(videoNode) {

    if (guiVideoEffectsFolder === null) {
        guiVideoEffectsFolder = guiMenus.video.addFolder(t("videoView.folders.videoAdjustments")).close().perm();
    }

    if (guiVideoProcessingFolder === null) {
        guiVideoProcessingFolder = guiMenus.video.addFolder(t("videoView.folders.videoProcessing")).close().perm();
    }

    if (guiVideoForensicsFolder === null) {
        guiVideoForensicsFolder = guiMenus.video.addFolder(t("videoView.folders.forensics")).close().perm();
        guiVideoForensicsFolder.onOpenClose(() => setRenderOne(true));
    }

    if (guiVideoELAFolder === null) {
        guiVideoELAFolder = guiVideoForensicsFolder.addFolder(t("videoView.folders.errorLevelAnalysis")).close().perm();
        guiVideoELAFolder.onOpenClose(() => setRenderOne(true));
    }

    if (guiVideoNoiseFolder === null) {
        guiVideoNoiseFolder = guiVideoForensicsFolder.addFolder(t("videoView.folders.noiseAnalysis")).close().perm();
        guiVideoNoiseFolder.onOpenClose(() => setRenderOne(true));
    }

    let brightness, contrast, levelsMidpoint, showHistogram, curves, showCurves, blur, greyscale, hue, invert, saturate, enableVideoEffects, convolutionFilter;
    let sharpenAmount, edgeDetectThreshold, embossDepth;
    let echoMin, echoMax, echoFrames, fullABEcho, fullABEchoOpacity, fullABBlend, fullABExposure;
    let showCache, elaJpegQuality, elaErrorScale, elaOpacity, elaExpandMethod, elaContrastClipPercent;
    let noiseBlockSize, noiseScale, noiseOpacity, noiseDisplayMode;
    let convolutionFilterDropdown, sharpenAmountControl, edgeDetectThresholdControl, embossDepthControl, elaExpandMethodDropdown, noiseDisplayModeDropdown;

    const filterOptions = {
        convolutionFilterValue: 'none'
    };

    const elaExpandMethodOptions = {
        methodValue: 'none'
    };

    const noiseDisplayModeOptions = {
        modeValue: 'heatmap'
    };

    const updateConvolutionControlVisibility = () => {
        const filterType = filterOptions.convolutionFilterValue;
        sharpenAmount?.show(filterType === 'sharpen');
        edgeDetectThreshold?.show(filterType === 'edgeDetect');
        embossDepth?.show(filterType === 'emboss');
    };

    const updateCurvesControlVisibility = () => {
        showCurves?.guiEntry?.show(curves?.value === true);
        videoNode.updateCurvesVisibility?.();
    };

    const updateELAExpandControlVisibility = () => {
        const method = elaExpandMethod?.value ?? elaExpandMethodOptions.methodValue ?? 'none';
        const needsClip = method === 'autoContrast' || method === 'autoContrastChannels';
        elaContrastClipPercent?.show(needsClip);
    };

    const reset = {
        resetFilters: () => {
            videoNode.inputs.brightness.value = 1;
            videoNode.inputs.contrast.value = 1;
            if (videoNode.inputs.levelsMidpoint) videoNode.inputs.levelsMidpoint.value = 1;
            if (videoNode.inputs.showHistogram) videoNode.inputs.showHistogram.value = true;
            if (videoNode.inputs.curves) videoNode.inputs.curves.value = false;
            if (videoNode.inputs.showCurves) videoNode.inputs.showCurves.value = true;
            videoNode.inputs.blur.value = 0;
            videoNode.inputs.greyscale.value = 0;
            videoNode.inputs.hue.value = 0;
            videoNode.inputs.invert.value = 0;
            videoNode.inputs.saturate.value = 1;
            if (videoNode.inputs.enableVideoEffects) {
                videoNode.inputs.enableVideoEffects.value = true;
            }
            filterOptions.convolutionFilterValue = 'none';
            if (videoNode.inputs.sharpenAmount) videoNode.inputs.sharpenAmount.value = 1;
            if (videoNode.inputs.edgeDetectThreshold) videoNode.inputs.edgeDetectThreshold.value = 0;
            if (videoNode.inputs.embossDepth) videoNode.inputs.embossDepth.value = 1;
            if (videoNode.inputs.echoMin) videoNode.inputs.echoMin.value = false;
            if (videoNode.inputs.echoMax) videoNode.inputs.echoMax.value = false;
            if (videoNode.inputs.echoFrames) videoNode.inputs.echoFrames.value = 10;
            if (videoNode.inputs.fullABEcho) videoNode.inputs.fullABEcho.value = false;
            if (videoNode.inputs.fullABBlend) videoNode.inputs.fullABBlend.value = false;
            if (videoNode.inputs.fullABExposure) videoNode.inputs.fullABExposure.value = false;
            if (videoNode.inputs.fullABEchoOpacity) videoNode.inputs.fullABEchoOpacity.value = 100;
            if (videoNode.inputs.showCache) videoNode.inputs.showCache.value = false;
            if (videoNode.inputs.elaJpegQuality) videoNode.inputs.elaJpegQuality.value = 90;
            if (videoNode.inputs.elaErrorScale) videoNode.inputs.elaErrorScale.value = 20;
            if (videoNode.inputs.elaOpacity) videoNode.inputs.elaOpacity.value = 65;
            if (videoNode.inputs.elaExpandMethod) videoNode.inputs.elaExpandMethod.value = 'none';
            if (videoNode.inputs.elaContrastClipPercent) videoNode.inputs.elaContrastClipPercent.value = 0.5;
            elaExpandMethodOptions.methodValue = 'none';
            elaExpandMethodDropdown?.updateDisplay();
            updateELAExpandControlVisibility();
            videoNode.invalidateELAResult();
            if (videoNode.inputs.noiseBlockSize) videoNode.inputs.noiseBlockSize.value = 16;
            if (videoNode.inputs.noiseScale) videoNode.inputs.noiseScale.value = 5;
            if (videoNode.inputs.noiseOpacity) videoNode.inputs.noiseOpacity.value = 65;
            if (videoNode.inputs.noiseDisplayMode) videoNode.inputs.noiseDisplayMode.value = 'heatmap';
            noiseDisplayModeOptions.modeValue = 'heatmap';
            noiseDisplayModeDropdown?.updateDisplay();
            videoNode.invalidateNoiseResult();
            updateCurvesControlVisibility();
            updateConvolutionControlVisibility();
            setRenderOne(true);
        }
    }

    if (!NodeMan.exists("videoBrightness")) {
            brightness = new CNodeGUIValue({ id: "videoBrightness", value: 1, start: 0, end: 5, step: 0.01, desc: "Brightness", tip: "Brightness multiplier (1 = normal)" }, guiVideoEffectsFolder),
            contrast = new CNodeGUIValue({ id: "videoContrast", value: 1, start: 0, end: 5, step: 0.01, desc: "Contrast", tip: "Contrast multiplier (1 = normal)" }, guiVideoEffectsFolder),
            levelsMidpoint = new CNodeGUIValue({ id: "videoLevelsMidpoint", value: 1, start: 0.1, end: 5, step: 0.01, desc: "Levels Midpoint", tip: "Gamma curve for midtones, like Photoshop's Levels midpoint slider (1 = normal, >1 brightens midtones, <1 darkens)" }, guiVideoEffectsFolder),
            showHistogram = new CNodeGUIFlag({ id: "videoShowHistogram", value: true, desc: "Histogram", tip: "Show the live video RGB histogram", onChange: () => {
                videoNode.updateHistogramVisibilityFromVideoAdjustments?.();
            }}, guiVideoEffectsFolder),
            curves = new CNodeGUIFlag({ id: "videoCurves", value: false, desc: "Curves", tip: "Apply the video tone curve", onChange: () => {
                updateCurvesControlVisibility();
            }}, guiVideoEffectsFolder),
            showCurves = new CNodeGUIFlag({ id: "videoShowCurves", value: true, desc: "Show Curves", tip: "Show the video tone curve editor when Curves is enabled", onChange: () => {
                videoNode.updateCurvesVisibility?.();
            }}, guiVideoEffectsFolder),
            blur = new CNodeGUIValue({ id: "videoBlur", value: 0, start: 0, end: 50, step: 0.05, desc: "Blur Src Px", tip: "Gaussian blur radius in source pixels (0 = none)" }, guiVideoEffectsFolder),
            greyscale = new CNodeGUIValue({ id: "videoGreyscale", value: 0, start: 0, end: 1, step: 0.01, desc: "Greyscale", tip: "Greyscale mix (0 = color, 1 = fully grey)" }, guiVideoEffectsFolder),
            hue = new CNodeGUIValue({ id: "videoHue", value: 0, start: 0, end: 360, step: 1, desc: "Hue Rotate", tip: "Rotate the hue of the video in degrees" }, guiVideoEffectsFolder),
            invert = new CNodeGUIValue({ id: "videoInvert", value: 0, start: 0, end: 1, step: 0.01, desc: "Invert", tip: "Invert colors (0 = normal, 1 = fully inverted)" }, guiVideoEffectsFolder),
            saturate = new CNodeGUIValue({ id: "videoSaturate", value: 1, start: 0, end: 5, step: 0.01, desc: "Saturate", tip: "Saturation multiplier (1 = normal, 0 = desaturated)" }, guiVideoEffectsFolder),
            enableVideoEffects = new CNodeGUIFlag({ id: "videoEnableEffects", value: true, desc: "Enable Video Effects", tip: "Master toggle for all video adjustments" }, guiVideoEffectsFolder),
            sharpenAmount = new CNodeGUIValue({ id: "videoSharpenAmount", value: 1, start: 0, end: 5, step: 0.1, desc: "Sharpen Amount", tip: "Strength of the sharpen convolution filter" }, guiVideoEffectsFolder),
            edgeDetectThreshold = new CNodeGUIValue({ id: "videoEdgeDetectThreshold", value: 0, start: 0, end: 255, step: 1, desc: "Edge Threshold", tip: "Minimum edge intensity to display (0 = show all)" }, guiVideoEffectsFolder),
            embossDepth = new CNodeGUIValue({ id: "videoEmbossDepth", value: 1, start: 0, end: 3, step: 0.1, desc: "Emboss Depth", tip: "Strength of the emboss convolution effect" }, guiVideoEffectsFolder),
            echoMin = new CNodeGUIFlag({ id: "videoEchoMin", value: false, desc: "Echo Dark", tip: "Accumulate darkest pixel values across frames", onChange: () => {
                videoNode.restartFullABEchoIfActive();
            }}, guiVideoProcessingFolder),
            echoMax = new CNodeGUIFlag({ id: "videoEchoMax", value: false, desc: "Echo Light", tip: "Accumulate brightest pixel values across frames", onChange: () => {
                videoNode.restartFullABEchoIfActive();
            }}, guiVideoProcessingFolder),
            echoFrames = new CNodeGUIValue({ id: "videoEchoFrames", value: 10, start: 2, end: 100, step: 1, desc: "Echo Frames", tip: "Number of frames to accumulate for echo effects" }, guiVideoProcessingFolder),
            fullABEcho = new CNodeGUIFlag({ id: "videoFullABEcho", value: false, desc: "Full A-B Echo", tip: "Echo accumulation across the full A-B frame range", onChange: () => {
                if (fullABEcho.value) {
                    if (fullABBlend.value) fullABBlend.value = false;
                    if (fullABExposure.value) fullABExposure.value = false;
                    if (!echoMin.value && !echoMax.value) {
                        echoMax.value = true;
                    }
                    videoNode.startFullABEcho();
                } else {
                    videoNode.stopFullABEcho();
                }
            }}, guiVideoProcessingFolder),
            fullABBlend = new CNodeGUIFlag({ id: "videoFullABBlend", value: false, desc: "Full A-B Blend", tip: "Average blend of all frames in the A-B range", onChange: () => {
                if (fullABBlend.value) {
                    if (fullABEcho.value) fullABEcho.value = false;
                    if (fullABExposure.value) fullABExposure.value = false;
                    videoNode.startFullABBlend();
                } else {
                    videoNode.stopFullABBlend();
                }
            }}, guiVideoProcessingFolder),
            fullABExposure = new CNodeGUIFlag({ id: "videoFullABExposure", value: false, desc: "Full A-B Exposure", tip: "Long-exposure simulation across the A-B frame range", onChange: () => {
                if (fullABExposure.value) {
                    if (fullABEcho.value) fullABEcho.value = false;
                    if (fullABBlend.value) fullABBlend.value = false;
                    videoNode.startFullABExposure();
                } else {
                    videoNode.stopFullABExposure();
                }
            }}, guiVideoProcessingFolder),
            fullABEchoOpacity = new CNodeGUIValue({ id: "videoFullABEchoOpacity", value: 100, start: 0, end: 100, step: 1, desc: "A-B Echo Opacity %", tip: "Opacity of the A-B echo/blend/exposure overlay" }, guiVideoProcessingFolder),
            showCache = new CNodeGUIFlag({ id: "videoShowCache", value: false, desc: "Show Cache", tip: "Show the current state of the video frame cache" }, guiVideoProcessingFolder),
            elaJpegQuality = new CNodeGUIValue({ id: "videoELAJpegQuality", value: 90, start: 1, end: 100, step: 1, desc: "JPEG Quality", tip: "JPEG compression quality used for error level re-encoding", onChange: () => {
                videoNode.invalidateELAResult();
            }}, guiVideoELAFolder),
            elaErrorScale = new CNodeGUIValue({ id: "videoELAErrorScale", value: 20, start: 0.1, end: 80, step: 0.1, desc: "Error Scale", tip: "Multiplier to amplify compression error differences", onChange: () => {
                videoNode.invalidateELAResult();
            }}, guiVideoELAFolder),
            elaOpacity = new CNodeGUIValue({ id: "videoELAOpacity", value: 65, start: 0, end: 100, step: 1, desc: "Opacity %", tip: "Opacity of the ELA overlay on the video" }, guiVideoELAFolder),
            elaExpandMethod = new CNodeConstant({ id: "videoELAExpandMethod", value: 'none' }),
            elaContrastClipPercent = new CNodeGUIValue({
                id: "videoELAContrastClipPercent",
                value: 0.5,
                start: 0,
                end: 10,
                step: 0.1,
                desc: "Clip %",
                tip: "Percentage of extreme values to clip for auto-contrast expansion",
                onChange: () => {
                    videoNode.invalidateELAResult();
                }
            }, guiVideoELAFolder),
            elaExpandMethodDropdown = guiVideoELAFolder.add(elaExpandMethodOptions, "methodValue", {
                "None": "none",
                "Histogram Equalization": "histogramEqualization",
                "Auto Contrast": "autoContrast",
                "Auto Contrast Channels": "autoContrastChannels"
            }).name(t("videoView.expandOutput.label")).tooltip(t("videoView.expandOutput.tooltip")).onChange(value => {
                elaExpandMethod.value = value;
                updateELAExpandControlVisibility();
                videoNode.invalidateELAResult();
                setRenderOne(true);
            }),
            noiseBlockSize = new CNodeGUIValue({ id: "videoNoiseBlockSize", value: 16, start: 4, end: 128, step: 1, desc: "Block Size", tip: "Size of blocks used for noise variance estimation", onChange: () => {
                videoNode.invalidateNoiseResult();
            }}, guiVideoNoiseFolder),
            noiseScale = new CNodeGUIValue({ id: "videoNoiseScale", value: 5, start: 0.1, end: 20, step: 0.1, desc: "Noise Scale", tip: "Multiplier to amplify the noise visualization", onChange: () => {
                videoNode.invalidateNoiseResult();
            }}, guiVideoNoiseFolder),
            noiseOpacity = new CNodeGUIValue({ id: "videoNoiseOpacity", value: 65, start: 0, end: 100, step: 1, desc: "Opacity %", tip: "Opacity of the noise analysis overlay" }, guiVideoNoiseFolder),
            noiseDisplayMode = new CNodeConstant({ id: "videoNoiseDisplayMode", value: 'heatmap' }),
            noiseDisplayModeDropdown = guiVideoNoiseFolder.add(noiseDisplayModeOptions, "modeValue", {
                "Noise Heatmap": "heatmap",
                "Noise Residual": "residual"
            }).name(t("videoView.displayMode.label")).tooltip(t("videoView.displayMode.tooltip")).onChange(value => {
                noiseDisplayMode.value = value;
                videoNode.invalidateNoiseResult();
                setRenderOne(true);
            }),
            convolutionFilter = new CNodeConstant({ id: "videoConvolutionFilter", value: 'none' }),
            convolutionFilterDropdown = guiVideoEffectsFolder.add(filterOptions, "convolutionFilterValue", ['none', 'sharpen', 'edgeDetect', 'emboss']).name(t("videoView.convolutionFilter.label")).tooltip(t("videoView.convolutionFilter.tooltip")).onChange(value => {
                convolutionFilter.value = value;
                updateConvolutionControlVisibility();
                setRenderOne(true);
            }),
            sharpenAmountControl = sharpenAmount.guiEntry,
            edgeDetectThresholdControl = edgeDetectThreshold.guiEntry,
            embossDepthControl = embossDepth.guiEntry,
            updateConvolutionControlVisibility(),
            guiVideoEffectsFolder.add(reset, "resetFilters").name(t("videoView.resetVideoAdjustments.label")).tooltip(t("videoView.resetVideoAdjustments.tooltip"))

        const makeVideoActions = { makeVideo: () => videoNode.makeProcessedVideo() };
        guiVideoProcessingFolder.add(makeVideoActions, "makeVideo").name(t("videoView.makeVideo.label")).tooltip(t("videoView.makeVideo.tooltip"));
    } else {
        brightness = NodeMan.get("videoBrightness");
        contrast = NodeMan.get("videoContrast");
        levelsMidpoint = NodeMan.get("videoLevelsMidpoint");
        showHistogram = NodeMan.get("videoShowHistogram");
        curves = NodeMan.get("videoCurves");
        showCurves = NodeMan.get("videoShowCurves");
        blur = NodeMan.get("videoBlur");
        greyscale = NodeMan.get("videoGreyscale");
        hue = NodeMan.get("videoHue");
        invert = NodeMan.get("videoInvert");
        saturate = NodeMan.get("videoSaturate");
        enableVideoEffects = NodeMan.get("videoEnableEffects");
        sharpenAmount = NodeMan.get("videoSharpenAmount");
        edgeDetectThreshold = NodeMan.get("videoEdgeDetectThreshold");
        embossDepth = NodeMan.get("videoEmbossDepth");
        echoMin = NodeMan.get("videoEchoMin");
        echoMax = NodeMan.get("videoEchoMax");
        echoFrames = NodeMan.get("videoEchoFrames");
        fullABEcho = NodeMan.get("videoFullABEcho");
        fullABBlend = NodeMan.get("videoFullABBlend");
        fullABExposure = NodeMan.get("videoFullABExposure");
        fullABEchoOpacity = NodeMan.get("videoFullABEchoOpacity");
        showCache = NodeMan.get("videoShowCache");
        elaJpegQuality = NodeMan.get("videoELAJpegQuality");
        elaErrorScale = NodeMan.get("videoELAErrorScale");
        elaOpacity = NodeMan.get("videoELAOpacity");
        elaExpandMethod = NodeMan.get("videoELAExpandMethod");
        elaContrastClipPercent = NodeMan.get("videoELAContrastClipPercent");
        noiseBlockSize = NodeMan.get("videoNoiseBlockSize");
        noiseScale = NodeMan.get("videoNoiseScale");
        noiseOpacity = NodeMan.get("videoNoiseOpacity");
        noiseDisplayMode = NodeMan.get("videoNoiseDisplayMode");
        convolutionFilter = NodeMan.get("videoConvolutionFilter");
        if (convolutionFilter) {
            filterOptions.convolutionFilterValue = convolutionFilter.value;
        }
        if (elaExpandMethod) {
            elaExpandMethodOptions.methodValue = elaExpandMethod.value;
        }
        if (noiseDisplayMode) {
            noiseDisplayModeOptions.modeValue = noiseDisplayMode.value;
        }
        sharpenAmountControl = sharpenAmount?.guiEntry;
        edgeDetectThresholdControl = edgeDetectThreshold?.guiEntry;
        embossDepthControl = embossDepth?.guiEntry;
        updateConvolutionControlVisibility();
    }

    updateCurvesControlVisibility();
    updateELAExpandControlVisibility();


    videoNode.addMoreInputs({
        brightness: brightness,
        contrast: contrast,
        levelsMidpoint: levelsMidpoint,
        showHistogram: showHistogram,
        curves: curves,
        showCurves: showCurves,
        blur: blur,
        greyscale: greyscale,
        hue: hue,
        invert: invert,
        saturate: saturate,
        enableVideoEffects: enableVideoEffects,
        convolutionFilter: convolutionFilter,
        sharpenAmount: sharpenAmount,
        edgeDetectThreshold: edgeDetectThreshold,
        embossDepth: embossDepth,
        echoMin: echoMin,
        echoMax: echoMax,
        echoFrames: echoFrames,
        fullABEcho: fullABEcho,
        fullABBlend: fullABBlend,
        fullABExposure: fullABExposure,
        fullABEchoOpacity: fullABEchoOpacity,
        showCache: showCache,
        elaJpegQuality: elaJpegQuality,
        elaErrorScale: elaErrorScale,
        elaOpacity: elaOpacity,
        elaExpandMethod: elaExpandMethod,
        elaContrastClipPercent: elaContrastClipPercent,
        noiseBlockSize: noiseBlockSize,
        noiseScale: noiseScale,
        noiseOpacity: noiseOpacity,
        noiseDisplayMode: noiseDisplayMode
    });

    EventManager.addEventListener("abFrameChanged", () => {
        videoNode.restartFullABEchoIfActive();
    });

    if (!NodeMan.exists("videoGridOverlay")) {
        const gridFolder = guiMenus.video.addFolder(t("videoView.folders.grid")).close();

        const gridOverlay = new CNodeGridOverlay({
            id: "videoGridOverlay",
            overlayView: videoNode,
        });

        gridFolder.add(gridOverlay, "gridShow").name(t("videoView.gridShow.label")).listen().onChange((value) => {
            gridOverlay.setShow(value);
        }).tooltip(t("videoView.gridShow.tooltip"));

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

    if (kernelName === 'sharpen') {
        kernel = [
            0, -1 * amount, 0,
            -1 * amount, 5 * amount, -1 * amount,
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
    const output = new Uint8ClampedArray(data.length);

    const w = width;
    const h = height;

    for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
            for (let c = 0; c < 4; c++) {
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
                if (kernelName === 'edgeDetect') {
                    output[(y * w + x) * 4 + c] = val > threshold ? 255 : 0;
                } else {
                    output[(y * w + x) * 4 + c] = Math.min(255, Math.max(0, val));
                }
            }
            output[((y * w + x) * 4 + 3)] = data[((y * w + x) * 4 + 3)];
        }
    }

    for (let i = 0; i < data.length; i += 4) {
        if (output[i] !== 0 || output[i + 1] !== 0 || output[i + 2] !== 0 || output[i + 3] !== 0) {
            data[i] = output[i];
            data[i + 1] = output[i + 1];
            data[i + 2] = output[i + 2];
        }
    }

    ctx.putImageData(imageData, 0, 0);
}

function getOrCachePixelData(videoView, frameImage, frame, width, height) {
    if (!videoView._echoPixelCache) {
        videoView._echoPixelCache = new Map();
    }

    const cached = videoView._echoPixelCache.get(frame);
    if (cached && cached.length === width * height * 4) {
        return cached;
    }

    const tmpCtx = videoView._echoTmpCtx;
    tmpCtx.drawImage(frameImage, 0, 0, width, height);
    const data = tmpCtx.getImageData(0, 0, width, height).data;
    videoView._echoPixelCache.set(frame, data);
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
    const numEchoFrames = Math.round(videoView.in.echoFrames?.v0 ?? 10);
    const startFrame = Math.max(0, currentFrame - numEchoFrames + 1);
    const width = currentImage.width;
    const height = currentImage.height;

    if (!videoView._echoCanvas || videoView._echoCanvas.width !== width || videoView._echoCanvas.height !== height) {
        videoView._echoCanvas = document.createElement('canvas');
        videoView._echoCanvas.width = width;
        videoView._echoCanvas.height = height;
        videoView._echoCtx = videoView._echoCanvas.getContext('2d', { willReadFrequently: true });
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

    const echoCtx = videoView._echoCtx;

    const pixelCount = width * height * 4;
    const minPixels = wantMin ? new Uint8ClampedArray(pixelCount) : null;
    const maxPixels = wantMax ? new Uint8ClampedArray(pixelCount) : null;
    const sumPixels = (wantMin && wantMax) ? new Float32Array(pixelCount) : null;
    let frameCount = 0;
    let initialized = false;

    for (let f = startFrame; f <= currentFrame; f++) {
        let frameImage;
        if (f === currentFrame) {
            frameImage = currentImage;
        } else {
            frameImage = videoView.videoData.getCachedImage(f);
        }
        if (!frameImage || frameImage.width === 0) continue;

        const frameData = getOrCachePixelData(videoView, frameImage, f, width, height);

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

    videoView._lastEchoFrame = currentFrame;
    videoView._lastEchoWantMin = wantMin;
    videoView._lastEchoWantMax = wantMax;
    videoView._lastEchoNumFrames = numEchoFrames;
    videoView._lastEchoResult = videoView._echoCanvas;

    return videoView._echoCanvas;
}

export function applyConvolutionToImage(image, kernelName, params, videoView) {
    if (kernelName === 'none' || !CONVOLUTION_KERNELS[kernelName]) return image;

    // Skip recalculation if the source image, kernel, and params are unchanged
    if (videoView._convolutionCanvas &&
        videoView._convLastImage === image &&
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

// Photoshop-style "Levels Midpoint" / gamma curve: output = input^(1/midpoint).
// midpoint > 1 brightens midtones, < 1 darkens them; black/white are preserved.
// Uses a cached 256-entry LUT to skip 4M+ Math.pow calls per HD frame.
export function applyLevelsMidpointToImage(image, midpoint, videoView) {
    if (!midpoint || midpoint === 1) return image;

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

    if (videoView._levelsLastImage === image && videoView._levelsLastMidpoint === midpoint) {
        return videoView._levelsMidpointCanvas;
    }

    if (videoView._levelsMidpointLUT === null || videoView._levelsLastMidpoint !== midpoint) {
        const lut = new Uint8ClampedArray(256);
        const invGamma = 1 / midpoint;
        for (let i = 0; i < 256; i++) {
            lut[i] = Math.round(Math.pow(i / 255, invGamma) * 255);
        }
        videoView._levelsMidpointLUT = lut;
    }

    const ctx = videoView._levelsMidpointCtx;
    ctx.drawImage(image, 0, 0, width, height);
    const imageData = ctx.getImageData(0, 0, width, height);
    const data = imageData.data;
    const lut = videoView._levelsMidpointLUT;

    for (let i = 0; i < data.length; i += 4) {
        data[i] = lut[data[i]];
        data[i + 1] = lut[data[i + 1]];
        data[i + 2] = lut[data[i + 2]];
    }

    ctx.putImageData(imageData, 0, 0);

    videoView._levelsLastImage = image;
    videoView._levelsLastMidpoint = midpoint;

    return videoView._levelsMidpointCanvas;
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

    for (let i = 0; i < data.length; i += 4) {
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
