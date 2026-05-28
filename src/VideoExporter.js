import {MediabunnyExporter} from "./MediabunnyExporter";
import {waitForExportFrameSettled} from "./ExportFrameSettler";
import {t} from "./i18n";

const isFirefox = typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox');
const defaultAccelerationOrder = isFirefox 
    ? ['prefer-software', 'no-preference'] 
    : ['prefer-hardware', 'prefer-software', 'no-preference'];

// When playback speed > 1 pushes desired fps above this, lock fps here and
// skip source frames at frameStep = desiredFps / MAX_OUTPUT_FPS. Cap is gated
// on speed > 1 so high-fps sources at 1x still encode at their native rate.
// Invariant: frameStep >= 1 always (cap can't shrink fps below desired).
const MAX_OUTPUT_FPS = 60;

export const VideoFormats = {
    'mp4-h264': {
        name: 'MP4 (H.264)',
        extension: 'mp4',
        format: 'mp4',
        codec: 'avc',
    },
    'webm-vp8': {
        name: 'WebM (VP8)',
        extension: 'webm',
        format: 'webm',
        codec: 'vp8',
    },
};

export const DefaultVideoFormat = 'mp4-h264';

export async function createVideoExporter(formatId, options) {
    const format = VideoFormats[formatId];
    if (!format) {
        throw new Error(`Unknown video format: ${formatId}`);
    }

    return new MediabunnyExporter({
        ...options,
        format: format.format,
        codec: format.codec,
        hardwareAcceleration: options.hardwareAcceleration,
    });
}

export function getVideoExtension(formatId) {
    const format = VideoFormats[formatId];
    return format ? format.extension : 'mp4';
}

export function getVideoFormatOptions() {
    return Object.entries(VideoFormats).reduce((acc, [key, value]) => {
        acc[value.name] = key;
        return acc;
    }, {});
}

async function checkH264Support(width, height) {
    const config = {
        width,
        height,
        framerate: 30,
        bitrate: 1_000_000,
        codec: 'avc1.640029',
        avc: { format: 'avc' },
    };
    
    for (const accel of defaultAccelerationOrder) {
        config.hardwareAcceleration = accel;
        try {
            if ((await VideoEncoder.isConfigSupported(config)).supported) {
                return { supported: true, hardwareAcceleration: accel };
            }
        } catch (e) {}
    }
    return { supported: false };
}

export async function checkVideoEncodingSupport() {
    if (typeof VideoEncoder === 'undefined') {
        return { supported: false, h264: false, vp8: false, reason: 'VideoEncoder API not available' };
    }
    
    let mp4MuxerAvailable = false;
    let webmMuxerAvailable = false;
    try {
        const { Mp4OutputFormat, WebMOutputFormat } = await import('mediabunny');
        mp4MuxerAvailable = typeof Mp4OutputFormat === 'function';
        webmMuxerAvailable = typeof WebMOutputFormat === 'function';
    } catch (e) {
        return { supported: false, h264: false, vp8: false, reason: 'Media muxer library not available' };
    }
    
    const h264Result = mp4MuxerAvailable ? await checkH264Support(640, 480) : { supported: false };
    
    let vp8 = false;
    if (webmMuxerAvailable) {
        const vp8Config = { width: 640, height: 480, framerate: 30, bitrate: 1_000_000, codec: 'vp8' };
        try {
            vp8 = (await VideoEncoder.isConfigSupported(vp8Config)).supported;
        } catch (e) {}
    }
    
    if (h264Result.supported || vp8) {
        return { 
            supported: true, 
            h264: h264Result.supported, 
            h264Acceleration: h264Result.hardwareAcceleration,
            vp8 
        };
    }
    return { supported: false, h264: false, vp8: false, reason: 'No video codecs available' };
}

export function getFilteredVideoFormatOptions(encodingSupport) {
    const options = {};
    if (encodingSupport.h264) {
        options[VideoFormats['mp4-h264'].name] = 'mp4-h264';
    }
    if (encodingSupport.vp8) {
        options[VideoFormats['webm-vp8'].name] = 'webm-vp8';
    }
    return options;
}

export function getDefaultVideoFormat(encodingSupport) {
    if (isFirefox && encodingSupport.vp8) return 'webm-vp8';
    if (encodingSupport.h264) return 'mp4-h264';
    if (encodingSupport.vp8) return 'webm-vp8';
    return null;
}

export async function checkCodecAtResolution(formatId, width, height) {
    if (typeof VideoEncoder === 'undefined') {
        return { supported: false, reason: 'VideoEncoder API not available' };
    }
    
    const encodedWidth = Math.ceil(width / 2) * 2;
    const encodedHeight = Math.ceil(height / 2) * 2;
    
    const format = VideoFormats[formatId];
    if (!format) {
        return { supported: false, reason: `Unknown format: ${formatId}` };
    }
    
    try {
        const { Mp4OutputFormat, WebMOutputFormat } = await import('mediabunny');
        if (format.format === 'mp4' && typeof Mp4OutputFormat !== 'function') {
            return { supported: false, reason: 'MP4 muxer not available' };
        }
        if (format.format === 'webm' && typeof WebMOutputFormat !== 'function') {
            return { supported: false, reason: 'WebM muxer not available' };
        }
    } catch (e) {
        return { supported: false, reason: 'Media muxer library not available' };
    }
    
    const config = {
        width: encodedWidth,
        height: encodedHeight,
        framerate: 30,
        bitrate: 5_000_000,
    };
    
    if (format.codec === 'avc') {
        config.avc = { format: 'avc' };
        const levels = ['avc1.640029', 'avc1.640032', 'avc1.640033', 'avc1.640034'];
        for (const accel of defaultAccelerationOrder) {
            config.hardwareAcceleration = accel;
            for (const level of levels) {
                config.codec = level;
                try {
                    if ((await VideoEncoder.isConfigSupported(config)).supported) {
                        return { supported: true, hardwareAcceleration: accel };
                    }
                } catch (e) {}
            }
        }
        return { supported: false, reason: `H.264 not supported at ${encodedWidth}x${encodedHeight}` };
    } else {
        config.codec = format.codec;
        try {
            if ((await VideoEncoder.isConfigSupported(config)).supported) {
                return { supported: true };
            }
        } catch (e) {}
        return { supported: false, reason: `${format.codec} not supported at ${encodedWidth}x${encodedHeight}` };
    }
}

export async function getBestFormatForResolution(preferredFormat, width, height) {
    const preferred = await checkCodecAtResolution(preferredFormat, width, height);
    if (preferred.supported) {
        return { 
            formatId: preferredFormat, 
            fallback: false,
            hardwareAcceleration: preferred.hardwareAcceleration,
        };
    }
    
    const fallbackId = preferredFormat === 'mp4-h264' ? 'webm-vp8' : 'mp4-h264';
    const fallback = await checkCodecAtResolution(fallbackId, width, height);
    if (fallback.supported) {
        return { 
            formatId: fallbackId, 
            fallback: true, 
            reason: preferred.reason,
            hardwareAcceleration: fallback.hardwareAcceleration,
        };
    }
    
    return { formatId: null, fallback: false, reason: `No codec supports ${width}x${height}` };
}

function buildBaseFrameSequence(startFrame, endFrame, pingPong, loops) {
    const forward = [];
    for (let frame = startFrame; frame <= endFrame; frame++) {
        forward.push(frame);
    }

    const oneLoop = [...forward];
    if (pingPong && forward.length > 1) {
        for (let i = forward.length - 2; i > 0; i--) {
            oneLoop.push(forward[i]);
        }
    }

    const sequence = [];
    for (let loop = 0; loop < loops; loop++) {
        sequence.push(...oneLoop);
    }
    return sequence;
}

export function createVideoExportFramePlan({
    startFrame,
    endFrame,
    sourceFps,
    playbackSpeed = 1,
    pingPong = false,
    loops = 1,
    maxOutputFps = MAX_OUTPUT_FPS,
}) {
    const speed = Number.isFinite(playbackSpeed) && playbackSpeed > 0 ? playbackSpeed : 1;
    const loopCount = Math.max(1, Math.min(20, Math.round(loops || 1)));
    const baseFps = sourceFps || 30;
    const sourceFrames = buildBaseFrameSequence(startFrame, endFrame, pingPong, loopCount);
    const desiredFps = baseFps * speed;
    const fps = speed > 1 ? Math.min(desiredFps, maxOutputFps) : desiredFps;
    const frameStep = desiredFps / fps;
    const totalFrames = Math.ceil(sourceFrames.length / frameStep);

    return {
        startFrame,
        endFrame,
        sourceFrames,
        totalSourceFrames: sourceFrames.length,
        totalFrames,
        fps,
        frameStep,
        playbackSpeed: speed,
        pingPong,
        loops: loopCount,
        frameAt(index) {
            return sourceFrames[Math.min(Math.round(index * frameStep), sourceFrames.length - 1)];
        },
    };
}

export function getVideoExportSpeedSuffix(plan) {
    const parts = [];
    if (plan.playbackSpeed !== 1) parts.push(`${plan.playbackSpeed}x`);
    if (plan.pingPong) parts.push("pingpong");
    if (plan.loops > 1) parts.push(`${plan.loops}loops`);
    return parts.length ? `_${parts.join("_")}` : "";
}

export function getVideoExportSpeedInfo(plan) {
    const parts = [];
    if (plan.playbackSpeed !== 1) parts.push(`${plan.playbackSpeed}x playback speed`);
    if (plan.pingPong) parts.push("In-Out pingpong");
    if (plan.loops > 1) parts.push(`${plan.loops} loops`);
    if (plan.frameStep > 1) parts.push(`capped at ${MAX_OUTPUT_FPS} fps, step ${plan.frameStep.toFixed(3)}`);
    return parts.length ? ` (${parts.join(", ")})` : "";
}

async function requestSourceFrameForExport(videoData, frame, timeout = 1500) {
    if (videoData.isFrameCached?.(frame)) return true;

    if (videoData.requestFrame) {
        videoData.requestFrame(frame);
    } else {
        videoData.getImage?.(frame);
    }

    const start = performance.now();
    while (performance.now() - start < timeout) {
        if (videoData.isFrameCached?.(frame)) return true;
        await new Promise(r => setTimeout(r, 10));
    }
    return videoData.isFrameCached?.(frame) ?? true;
}

export class VideoExportManager {
    constructor() {
        this.videoExportView = "lookView";
        this.retinaExport = false;
        this.exportAudio = true;
        this.videoExportLoops = 1;
        // Export-time quality switch:
        // false (default) = capture as fast as possible
        // true            = wait for background terrain/3D tile/video settling per frame
        this.waitForBackgroundLoading = false;
        this.videoFormat = null;
        this.renderVideoFolder = null;
    }

    async setupMenu(parentFolder, options = {}) {
        const { ViewMan } = await import("./CViewManager");
        const { setupPanoramaExport } = await import("./PanoramaExporter");

        const getExportableViews = () => {
            const views = [];
            ViewMan.iterate((id, view) => {
                if (!view.overlayView && view.exportVideo) {
                    views.push(id);
                }
            });
            return views;
        };

        const exportableViews = getExportableViews();

        if (exportableViews.length > 0 && !exportableViews.includes(this.videoExportView)) {
            this.videoExportView = exportableViews[0];
        }

        const encodingSupport = await checkVideoEncodingSupport();
        if (!encodingSupport.supported) {
            parentFolder.add({ label: t("videoExport.notAvailable") }, "label")
                .name(t("videoExport.notAvailable"))
                .disable()
                .tooltip(encodingSupport.reason || t("videoExport.notAvailable"));
            return;
        }

        this.videoFormat = getDefaultVideoFormat(encodingSupport);
        const formatOptions = getFilteredVideoFormatOptions(encodingSupport);

        this.renderVideoFolder = parentFolder.addFolder(t("videoExport.folder.title")).close()
            .tooltip(t("videoExport.folder.tooltip"));

        if (exportableViews.length > 0) {
            this.renderVideoFolder.add(this, "videoExportView", exportableViews)
                .name(t("videoExport.renderView.label"))
                .tooltip(t("videoExport.renderView.tooltip"));

            this.renderVideoFolder.add({
                exportVideo: () => {
                    const view = ViewMan.get(this.videoExportView, false);
                    if (view && view.exportVideo) {
                        // Keep single-view export behavior in sync with viewport export toggle semantics.
                        view.exportVideo(this.videoFormat, this.exportAudio, this.waitForBackgroundLoading, {
                            loops: this.videoExportLoops,
                        });
                    }
                }
            }, "exportVideo").name(t("videoExport.renderSingleVideo.label"))
                .tooltip(t("videoExport.renderSingleVideo.tooltip"));
        }

        if (Object.keys(formatOptions).length > 1) {
            this.renderVideoFolder.add(this, "videoFormat", formatOptions)
                .name(t("videoExport.videoFormat.label"))
                .tooltip(t("videoExport.videoFormat.tooltip"));
        }

        this.renderVideoFolder.add(this, "videoExportLoops", 1, 20, 1)
            .name(t("videoExport.loops.label"))
            .tooltip(t("videoExport.loops.tooltip"));

        this.renderVideoFolder.add({
            exportSourceVideo: () => this.exportSourceVideo()
        }, "exportSourceVideo").name(t("videoExport.renderSource.label"))
            .tooltip(t("videoExport.renderSource.tooltip"));

        this.renderVideoFolder.add({
            exportViewport: () => this.exportViewportVideo()
        }, "exportViewport").name(t("videoExport.renderViewport.label"))
            .tooltip(t("videoExport.renderViewport.tooltip"));

        this.renderVideoFolder.add({
            exportFullscreenViewport: () => this.exportFullscreenViewportVideo()
        }, "exportFullscreenViewport").name(t("videoExport.renderFullscreen.label"))
            .tooltip(t("videoExport.renderFullscreen.tooltip"));

        this.renderVideoFolder.add({
            exportWindow: () => this.exportWindowVideo()
        }, "exportWindow").name(t("videoExport.recordWindow.label"))
            .tooltip(t("videoExport.recordWindow.tooltip"));

        this.renderVideoFolder.add(this, "retinaExport")
            .name(t("videoExport.retinaExport.label"))
            .tooltip(t("videoExport.retinaExport.tooltip"));

        this.renderVideoFolder.add(this, "exportAudio")
            .name(t("videoExport.includeAudio.label"))
            .tooltip(t("videoExport.includeAudio.tooltip"));

        this.renderVideoFolder.add(this, "waitForBackgroundLoading")
            .name(t("videoExport.waitForLoading.label"))
            .tooltip(t("videoExport.waitForLoading.tooltip"));

        this.renderVideoFolder.add({
            exportFrameJpg: () => this.exportVideoFrame("jpg")
        }, "exportFrameJpg").name(t("videoExport.exportFrameJpg.label"))
            .tooltip(t("videoExport.exportFrameJpg.tooltip"));

        this.renderVideoFolder.add({
            exportFramePng: () => this.exportVideoFrame("png")
        }, "exportFramePng").name(t("videoExport.exportFramePng.label"))
            .tooltip(t("videoExport.exportFramePng.tooltip"));

        if (!options.skipPanorama) {
            setupPanoramaExport(this.renderVideoFolder);
        }

        return this.renderVideoFolder;
    }

    async exportSourceVideo() {
        const { GlobalDateTimeNode, NodeMan, Sit, setRenderOne } = await import("./Globals");
        const { par } = await import("./par");
        const { ExportProgressWidget, getExportPrefix } = await import("./utils");

        const videoView = NodeMan.get("video", false);
        if (!videoView || !videoView.videoData || !videoView.drawAdjustedSourceFrame) {
            alert("No source video available to render.");
            return;
        }

        const videoData = videoView.videoData;
        const startFrame = Math.max(0, Sit.aFrame ?? 0);
        const lastVideoFrame = Math.max(0, (videoData.frames ?? Sit.frames ?? 1) - 1);
        const endFrame = Math.min(Sit.bFrame ?? lastVideoFrame, lastVideoFrame);
        if (endFrame < startFrame) {
            alert("Invalid A-B range for source video render.");
            return;
        }

        const sourceCanvas = document.createElement("canvas");
        await requestSourceFrameForExport(videoData, startFrame, 3000);
        if (!videoView.drawAdjustedSourceFrame(startFrame, sourceCanvas)) {
            alert("Could not render the first source video frame.");
            return;
        }

        const width = sourceCanvas.width;
        const height = sourceCanvas.height;
        const plan = createVideoExportFramePlan({
            startFrame,
            endFrame,
            sourceFps: videoData.originalFps || Sit.fps || 30,
            playbackSpeed: par.playbackSpeed ?? 1,
            pingPong: par.pingPong,
            loops: this.videoExportLoops,
        });

        const bestFormat = await getBestFormatForResolution(this.videoFormat, width, height);
        if (!bestFormat.formatId) {
            alert(`Source video render failed: ${bestFormat.reason}`);
            return;
        }
        if (bestFormat.fallback) {
            console.log(`${bestFormat.reason}, falling back to ${bestFormat.formatId}`);
        }

        const formatId = bestFormat.formatId;
        const extension = getVideoExtension(formatId);

        let audioBuffer = null;
        let audioStartTime = 0;
        let audioDuration = null;
        let originalFps = plan.fps;
        const canIncludeAudio = this.exportAudio && plan.playbackSpeed === 1 && !plan.pingPong && plan.loops === 1;
        if (canIncludeAudio && videoData.audioHandler && videoData.audioHandler.decodingComplete) {
            audioBuffer = videoData.audioHandler.getAudioBufferForExport();
            originalFps = videoData.audioHandler.originalFps || plan.fps;
            audioStartTime = startFrame / originalFps;
            audioDuration = plan.totalFrames / plan.fps;
        } else if (this.exportAudio && !canIncludeAudio) {
            console.log("Audio export skipped: playback speed, A-B pingpong, or loops would desync from source audio");
        }

        const speedInfo = getVideoExportSpeedInfo(plan);
        console.log(`Starting source video render (${formatId}): ${plan.totalFrames} output frames from ${plan.totalSourceFrames} source (${startFrame}-${endFrame}) at ${plan.fps} fps${speedInfo}, ${width}x${height}`);

        const savedFrame = par.frame;
        const savedPaused = par.paused;
        par.paused = true;

        const progress = new ExportProgressWidget("Rendering source video...", plan.totalFrames);
        const videoStartDate = GlobalDateTimeNode ? GlobalDateTimeNode.frameToDate(startFrame) : null;

        try {
            const exporter = await createVideoExporter(formatId, {
                width,
                height,
                fps: plan.fps,
                bitrate: 10_000_000,
                keyFrameInterval: Math.max(1, Math.round(plan.fps)),
                videoStartDate,
                audioBuffer,
                audioStartTime,
                audioDuration,
                originalFps,
                hardwareAcceleration: bestFormat.hardwareAcceleration,
            });

            await exporter.initialize();

            for (let i = 0; i < plan.totalFrames; i++) {
                if (progress.shouldStop()) break;

                const frame = plan.frameAt(i);
                par.frame = frame;
                if (GlobalDateTimeNode) GlobalDateTimeNode.update(frame);
                await requestSourceFrameForExport(videoData, frame);

                if (videoView.drawAdjustedSourceFrame(frame, sourceCanvas)) {
                    // Composite annotations on top, at original-video resolution.
                    const annotateOverlay = NodeMan.get("annotateOverlay", false);
                    if (annotateOverlay?.renderToVideoCanvas) {
                        annotateOverlay.renderToVideoCanvas(sourceCanvas, frame);
                    }
                    await exporter.addFrame(sourceCanvas, i);
                }

                if (i % 10 === 0 || i === plan.totalFrames - 1) {
                    progress.update(i + 1);
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            if (progress.shouldSave()) {
                const blob = await exporter.finalize(
                    (current, total) => progress.setFinalizeProgress(current, total),
                    (status) => progress.setStatus(status)
                );

                const filename = `${getExportPrefix()}_source${getVideoExportSpeedSuffix(plan)}_${new Date().toISOString().slice(0, 19).replace(/:/g, "-")}.${extension}`;
                const url = URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;
                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);

                console.log(`Source video render complete: ${filename}`);
            } else {
                console.log("Source video render aborted by user");
            }
        } catch (e) {
            console.error("Source video render failed:", e);
            alert("Source video render failed: " + e.message);
        } finally {
            progress.remove();
            par.frame = savedFrame;
            par.paused = savedPaused;
            setRenderOne(true);
        }
    }

    async exportVideoFrame(format = "png") {
        const { NodeMan } = await import("./Globals");
        const { par } = await import("./par");
        const { saveAs } = await import("file-saver");
        const { getExportPrefix } = await import("./utils");

        const videoView = NodeMan.get("video", false);
        if (!videoView || !videoView.canvas) {
            alert("No video view available to export.");
            return;
        }

        const frame = Math.floor(par.frame);
        const isJpg = format === "jpg" || format === "jpeg";
        const extension = isJpg ? "jpg" : "png";
        const mimeType = isJpg ? "image/jpeg" : "image/png";
        const quality = isJpg ? 0.92 : undefined;
        const fileName = `${getExportPrefix()}_frame_${String(frame).padStart(5, "0")}.${extension}`;

        // Composite the video canvas with the annotation overlay (if any) so
        // exported frames match what the user sees on screen.
        const annotateOverlay = NodeMan.get("annotateOverlay", false);
        if (annotateOverlay?.show && annotateOverlay?.canvas && annotateOverlay?.strokes?.length) {
            const composite = document.createElement("canvas");
            composite.width = videoView.canvas.width;
            composite.height = videoView.canvas.height;
            const cctx = composite.getContext("2d");
            cctx.drawImage(videoView.canvas, 0, 0);
            cctx.drawImage(annotateOverlay.canvas, 0, 0,
                composite.width, composite.height);
            composite.toBlob((blob) => {
                if (blob) saveAs(blob, fileName);
            }, mimeType, quality);
            return;
        }
        videoView.canvas.toBlob((blob) => {
            if (blob) {
                saveAs(blob, fileName);
            }
        }, mimeType, quality);
    }

    async exportViewportVideo() {
        const { ViewMan } = await import("./CViewManager");
        const { GlobalDateTimeNode, NodeMan, Sit, Globals, setRenderOne } = await import("./Globals");
        const { par } = await import("./par");
        const { GlobalScene, LocalFrame } = await import("./LocalFrame");
        const { Frame2Az, Frame2El } = await import("./JetUtils");
        const { UpdatePRFromEA } = await import("./JetStuff");
        const { ExportProgressWidget, drawVideoWatermark } = await import("./utils");
        const { drawAttributionOnCanvas } = await import("./AttributionOverlay");
        const { getMotionAnalysisOverlays } = await import("./CMotionAnalysisUI");
        const { CNodeView3D } = await import("./nodes/CNodeView3D");

        const startFrame = Sit.aFrame;
        const endFrame = Sit.bFrame;
        const scale = this.retinaExport ? (window.devicePixelRatio || 1) : 1;
        const width = Math.round(ViewMan.widthPx * scale);
        const height = Math.round(ViewMan.heightPx * scale);
        const plan = createVideoExportFramePlan({
            startFrame,
            endFrame,
            sourceFps: Sit.fps,
            playbackSpeed: par.playbackSpeed ?? 1,
            pingPong: par.pingPong,
            loops: this.videoExportLoops,
        });

        const bestFormat = await getBestFormatForResolution(this.videoFormat, width, height);
        if (!bestFormat.formatId) {
            alert(`Video export failed: ${bestFormat.reason}`);
            return;
        }
        if (bestFormat.fallback) {
            console.log(`${bestFormat.reason}, falling back to ${bestFormat.formatId}`);
        }

        const formatId = bestFormat.formatId;
        const extension = getVideoExtension(formatId);

        const speedInfo = getVideoExportSpeedInfo(plan);
        console.log(`Starting viewport video export (${formatId}): ${plan.totalFrames} output frames from ${plan.totalSourceFrames} source (${startFrame}-${endFrame}) at ${plan.fps} fps${speedInfo}, ${width}x${height} (scale: ${scale}x)`);

        const savedFrame = par.frame;
        const savedPaused = par.paused;
        par.paused = true;

        const progress = new ExportProgressWidget('Exporting viewport video...', plan.totalFrames);

        const compositeCanvas = document.createElement('canvas');
        compositeCanvas.width = width;
        compositeCanvas.height = height;
        const compositeCtx = compositeCanvas.getContext('2d');

        const videoStartDate = GlobalDateTimeNode ? GlobalDateTimeNode.frameToDate(startFrame) : null;

        let audioBuffer = null;
        let audioStartTime = 0;
        let audioDuration = null;
        let originalFps = plan.fps;

        const canIncludeAudio = this.exportAudio && plan.playbackSpeed === 1 && !plan.pingPong && plan.loops === 1;
        if (canIncludeAudio) {
            for (const entry of Object.values(NodeMan.list)) {
                const node = entry.data;
                if (node.videoData && node.videoData.audioHandler &&
                    node.videoData.audioHandler.decodingComplete) {
                    const exportAudioBuffer = node.videoData.audioHandler.getAudioBufferForExport();
                    if (exportAudioBuffer) {
                        audioBuffer = exportAudioBuffer;
                        originalFps = node.videoData.audioHandler.originalFps || plan.fps;
                        audioStartTime = startFrame / originalFps;
                        audioDuration = plan.totalFrames / plan.fps;
                        console.log(`Found audio: ${audioBuffer.duration.toFixed(2)}s, using ${audioDuration.toFixed(2)}s from ${audioStartTime.toFixed(2)}s`);
                        break;
                    }
                }
            }
        } else if (this.exportAudio) {
            console.log("Audio export skipped: playback speed, A-B pingpong, or loops would desync from video");
        }

        try {
            const exporter = await createVideoExporter(formatId, {
                width,
                height,
                fps: plan.fps,
                bitrate: 8_000_000 * scale * scale,
                keyFrameInterval: 30,
                videoStartDate,
                audioBuffer,
                audioStartTime,
                audioDuration,
                originalFps,
                hardwareAcceleration: bestFormat.hardwareAcceleration,
            });

            await exporter.initialize();

            for (let i = 0; i < plan.totalFrames; i++) {
                if (progress.shouldStop()) break;

                const frame = plan.frameAt(i);
                const visible3DViewIds = [];
                const renderCompositeFrame = async () => {
                    par.frame = frame;
                    GlobalDateTimeNode.update(frame);

                    if (Sit.azSlider) {
                        par.az = Frame2Az(par.frame);
                        par.el = Frame2El(par.frame);
                        UpdatePRFromEA();
                    }

                    for (const entry of Object.values(NodeMan.list)) {
                        const node = entry.data;
                        if (node.update !== undefined) {
                            node.update(frame);
                        }
                        if (node.videoData && node.videoData.waitForFrame) {
                            await node.videoData.waitForFrame(frame);
                        }
                    }

                    GlobalScene.updateMatrixWorld(true);
                    if (LocalFrame) LocalFrame.updateMatrixWorld(true);

                    compositeCtx.fillStyle = '#000000';
                    compositeCtx.fillRect(0, 0, width, height);

                    const nonOverlays = [];
                    const overlays = [];

                    visible3DViewIds.length = 0;
                    ViewMan.computeEffectiveVisibility();

                    ViewMan.iterate((id, view) => {
                        if (view._effectivelyVisible) {
                            if (view.overlayView) {
                                overlays.push(view);
                            } else {
                                nonOverlays.push(view);
                                if (view instanceof CNodeView3D) {
                                    visible3DViewIds.push(id);
                                }
                            }
                        }
                    });

                    for (const view of nonOverlays) {
                        if (view.camera && view instanceof CNodeView3D) {
                            view.camera.updateMatrix();
                            view.camera.updateMatrixWorld();
                            for (const node of NodeMan.getPreRenderNodes()) {
                                node.preRender(view);
                            }
                        }
                        view.renderCanvas(frame);
                        for (const node of NodeMan.getPostRenderNodes()) {
                            node.postRender(view);
                        }
                        if (view.renderer) {
                            view.renderer.getContext().finish();
                        }
                        if (view.canvas) {
                            const x = view.leftPx * scale;
                            const y = (view.topPx - ViewMan.topPx) * scale;
                            compositeCtx.drawImage(view.canvas, x, y, view.widthPx * scale, view.heightPx * scale);
                        }
                    }

                    for (const view of overlays) {
                        const alpha = view.transparency !== undefined ? view.transparency : 1;
                        if (alpha <= 0) continue;
                        if (view.canvas && (view.canvas.style.display === "none" || view.canvas.style.visibility === "hidden")) {
                            // Hidden overlay canvases can retain stale pixels if they were previously shown.
                            // Skip drawing them to match on-screen presentation.
                            continue;
                        }

                        if (view.canvas) {
                            const ctx = view.canvas.getContext('2d');
                            ctx.clearRect(0, 0, view.canvas.width, view.canvas.height);
                        }
                        if (view.camera && view instanceof CNodeView3D) {
                            view.camera.updateMatrix();
                            view.camera.updateMatrixWorld();
                            for (const node of NodeMan.getPreRenderNodes()) {
                                node.preRender(view);
                            }
                        }
                        view.renderCanvas(frame);
                        for (const node of NodeMan.getPostRenderNodes()) {
                            node.postRender(view);
                        }
                        if (view.canvas) {
                            const parentView = view.overlayView;
                            const x = parentView.leftPx * scale;
                            const y = (parentView.topPx - ViewMan.topPx) * scale;
                            compositeCtx.globalAlpha = alpha;
                            compositeCtx.drawImage(view.canvas, x, y, parentView.widthPx * scale, parentView.heightPx * scale);
                            compositeCtx.globalAlpha = 1;
                        }
                    }

                    const motionOverlays = getMotionAnalysisOverlays();
                    if (motionOverlays && motionOverlays.videoView) {
                        const vv = motionOverlays.videoView;
                        const x = vv.leftPx * scale;
                        const y = (vv.topPx - ViewMan.topPx) * scale;
                        if (motionOverlays.overlay) {
                            compositeCtx.drawImage(motionOverlays.overlay, x, y, vv.widthPx * scale, vv.heightPx * scale);
                        }
                        if (motionOverlays.graphCanvas) {
                            const gw = 200 * scale;
                            const gh = 80 * scale;
                            const gx = x + vv.widthPx * scale - gw - 10 * scale;
                            const gy = y + vv.heightPx * scale - gh - 10 * scale;
                            compositeCtx.drawImage(motionOverlays.graphCanvas, gx, gy, gw, gh);
                        }
                    }

                    drawVideoWatermark(compositeCtx, width);
                    drawAttributionOnCanvas(compositeCtx, width, height);
                };

                await renderCompositeFrame();
                if (this.waitForBackgroundLoading) {
                    // Wait for async loading and 3D tile visibility churn to settle before encoding the frame.
                    await waitForExportFrameSettled({
                        frame,
                        viewIds: visible3DViewIds,
                        renderFrame: renderCompositeFrame,
                        logPrefix: "Viewport video export",
                    });
                }

                await exporter.addFrame(compositeCanvas, frame);

                if (i % 10 === 0) {
                    progress.update(i + 1);
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            if (progress.shouldSave()) {
                const blob = await exporter.finalize(
                    (current, total) => progress.setFinalizeProgress(current, total),
                    (status) => progress.setStatus(status)
                );

                const { getExportPrefix } = await import("./utils");
                const filename = `${getExportPrefix()}_viewport${getVideoExportSpeedSuffix(plan)}_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${extension}`;
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);

                console.log(`Viewport video export complete: ${filename}`);
            } else {
                console.log('Viewport video export aborted by user');
            }

        } catch (e) {
            console.error('Export failed:', e);
            alert('Viewport video export failed: ' + e.message);
        } finally {
            progress.remove();
            par.frame = savedFrame;
            par.paused = savedPaused;
            setRenderOne(true);
        }
    }

    async exportFullscreenViewportVideo() {
        const { Globals } = await import("./Globals");
        const { openFullscreen, closeFullscreen } = await import("./utils");
        const { updateSize } = await import("./JetStuff");

        const uiWasVisible = !Globals.menuBar._hidden;
        try {
            if (uiWasVisible) {
                Globals.menuBar.toggleVisiblity();
            }
            openFullscreen();
            await new Promise(resolve => {
                const handler = () => {
                    document.removeEventListener('fullscreenchange', handler);
                    document.removeEventListener('webkitfullscreenchange', handler);
                    updateSize(true);
                    setTimeout(resolve, 100);
                };
                document.addEventListener('fullscreenchange', handler);
                document.addEventListener('webkitfullscreenchange', handler);
            });
            await this.exportViewportVideo();
        } finally {
            closeFullscreen();
            if (uiWasVisible) {
                Globals.menuBar.toggleVisiblity();
            }
        }
    }

    async exportWindowVideo() {
        const { GlobalDateTimeNode, NodeMan, Sit, setRenderOne, guiMenus } = await import("./Globals");
        const { par } = await import("./par");
        const { drawVideoWatermark } = await import("./utils");
        const { drawAttributionOnCanvas } = await import("./AttributionOverlay");

        if (this.renderVideoFolder) {
            this.renderVideoFolder.close();
        }

        const viewMenu = guiMenus.view;
        const viewMenuWasOpen = viewMenu && !viewMenu._closed;
        if (viewMenuWasOpen && viewMenu.mode !== "SIDEBAR_LEFT" && viewMenu.mode !== "SIDEBAR_RIGHT") {
            viewMenu.close();
        }

        let displayStream;
        try {
            displayStream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: { max: 60 } },
                preferCurrentTab: true,
            });
        } catch (e) {
            console.error('getDisplayMedia failed:', e);
            alert('Window recording cancelled or not supported: ' + e.message);
            return;
        }

        const videoTrack = displayStream.getVideoTracks()[0];
        const trackSettings = videoTrack.getSettings();
        const captureWidth = trackSettings.width;
        const captureHeight = trackSettings.height;

        const videoEl = document.createElement('video');
        videoEl.srcObject = displayStream;
        videoEl.muted = true;
        videoEl.playsInline = true;
        await videoEl.play();

        await new Promise(r => setTimeout(r, 200));

        const startFrame = Sit.aFrame;
        const endFrame = Sit.bFrame;
        const plan = createVideoExportFramePlan({
            startFrame,
            endFrame,
            sourceFps: Sit.fps,
            playbackSpeed: par.playbackSpeed ?? 1,
            pingPong: par.pingPong,
            loops: this.videoExportLoops,
        });

        const width = Math.ceil(captureWidth / 2) * 2;
        const height = Math.ceil(captureHeight / 2) * 2;

        const bestFormat = await getBestFormatForResolution(this.videoFormat, width, height);
        if (!bestFormat.formatId) {
            displayStream.getTracks().forEach(t => t.stop());
            alert(`Video export failed: ${bestFormat.reason}`);
            return;
        }
        if (bestFormat.fallback) {
            console.log(`${bestFormat.reason}, falling back to ${bestFormat.formatId}`);
        }

        const formatId = bestFormat.formatId;
        const extension = getVideoExtension(formatId);

        const winSpeedInfo = getVideoExportSpeedInfo(plan);
        console.log(`Starting window video export (${formatId}): ${plan.totalFrames} output frames from ${plan.totalSourceFrames} source (${startFrame}-${endFrame}) at ${plan.fps} fps${winSpeedInfo}, ${width}x${height}`);

        const savedFrame = par.frame;
        const savedPaused = par.paused;
        const savedTitle = document.title;
        par.paused = true;

        let stopEarly = false;
        let abortExport = false;
        const onKeyDown = (e) => {
            if (e.key === 'Escape') { abortExport = true; }
            if (e.key === 'Enter') { stopEarly = true; }
        };
        document.addEventListener('keydown', onKeyDown);

        const captureCanvas = document.createElement('canvas');
        captureCanvas.width = width;
        captureCanvas.height = height;
        const captureCtx = captureCanvas.getContext('2d');

        const videoStartDate = GlobalDateTimeNode ? GlobalDateTimeNode.frameToDate(startFrame) : null;

        let audioBuffer = null;
        let audioStartTime = 0;
        let audioDuration = null;
        let originalFps = plan.fps;

        const canIncludeAudio = this.exportAudio && plan.playbackSpeed === 1 && !plan.pingPong && plan.loops === 1;
        if (canIncludeAudio) {
            for (const entry of Object.values(NodeMan.list)) {
                const node = entry.data;
                if (node.videoData && node.videoData.audioHandler &&
                    node.videoData.audioHandler.decodingComplete) {
                    const exportAudioBuffer = node.videoData.audioHandler.getAudioBufferForExport();
                    if (exportAudioBuffer) {
                        audioBuffer = exportAudioBuffer;
                        originalFps = node.videoData.audioHandler.originalFps || plan.fps;
                        audioStartTime = startFrame / originalFps;
                        audioDuration = plan.totalFrames / plan.fps;
                        break;
                    }
                }
            }
        } else if (this.exportAudio) {
            console.log("Audio export skipped: playback speed, A-B pingpong, or loops would desync from video");
        }

        const waitForPaint = () => new Promise(resolve => {
            requestAnimationFrame(() => {
                requestAnimationFrame(resolve);
            });
        });

        try {
            const exporter = await createVideoExporter(formatId, {
                width,
                height,
                fps: plan.fps,
                bitrate: 8_000_000,
                keyFrameInterval: 30,
                videoStartDate,
                audioBuffer,
                audioStartTime,
                audioDuration,
                originalFps,
                hardwareAcceleration: bestFormat.hardwareAcceleration,
            });

            await exporter.initialize();

            for (let i = 0; i < plan.totalFrames; i++) {
                if (stopEarly || abortExport) break;
                if (videoTrack.readyState !== 'live') {
                    console.warn('Display capture stream ended');
                    break;
                }

                const frame = plan.frameAt(i);
                par.frame = frame;
                if (GlobalDateTimeNode) GlobalDateTimeNode.update(frame);

                for (const entry of Object.values(NodeMan.list)) {
                    const node = entry.data;
                    if (node.videoData && node.videoData.waitForFrame) {
                        await node.videoData.waitForFrame(frame);
                    }
                }

                const renderWindowFrame = async () => {
                    setRenderOne(true);
                    await waitForPaint();
                };

                await renderWindowFrame();
                if (this.waitForBackgroundLoading) {
                    // Same settling gate as viewport export, but for captured browser-window frames.
                    await waitForExportFrameSettled({
                        frame,
                        renderFrame: renderWindowFrame,
                        logPrefix: "Window video export",
                    });
                }

                captureCtx.fillStyle = '#000000';
                captureCtx.fillRect(0, 0, width, height);
                captureCtx.drawImage(videoEl, 0, 0, width, height);

                drawVideoWatermark(captureCtx, width);
                drawAttributionOnCanvas(captureCtx, width, height);

                await exporter.addFrame(captureCanvas, frame);

                if (i % 10 === 0) {
                    document.title = `Recording ${i + 1}/${plan.totalFrames} [Enter=save, Esc=abort]`;
                    await new Promise(r => setTimeout(r, 0));
                }
            }

            if (!abortExport) {
                document.title = 'Finalizing video...';
                const blob = await exporter.finalize(
                    null,
                    (status) => { document.title = status; }
                );

                const { getExportPrefix } = await import("./utils");
                const filename = `${getExportPrefix()}_window${getVideoExportSpeedSuffix(plan)}_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${extension}`;
                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                a.href = url;
                a.download = filename;
                a.click();
                URL.revokeObjectURL(url);

                console.log(`Window video export complete: ${filename}`);
            } else {
                console.log('Window video export aborted by user');
            }

        } catch (e) {
            console.error('Export failed:', e);
            alert('Window video export failed: ' + e.message);
        } finally {
            document.removeEventListener('keydown', onKeyDown);
            document.title = savedTitle;
            displayStream.getTracks().forEach(t => t.stop());
            videoEl.srcObject = null;
            par.frame = savedFrame;
            par.paused = savedPaused;
            setRenderOne(true);
        }
    }
}
