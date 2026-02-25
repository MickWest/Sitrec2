import {MediabunnyExporter} from "./MediabunnyExporter";

const isFirefox = typeof navigator !== 'undefined' && navigator.userAgent.includes('Firefox');
const defaultAccelerationOrder = isFirefox 
    ? ['prefer-software', 'no-preference'] 
    : ['prefer-hardware', 'prefer-software', 'no-preference'];

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

export class VideoExportManager {
    constructor() {
        this.videoExportView = "lookView";
        this.retinaExport = false;
        this.exportAudio = true;
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
            parentFolder.add({ label: "Video Export Not Available" }, "label")
                .name("Video Export Not Available")
                .disable()
                .tooltip(encodingSupport.reason || "Video encoding is not supported in this browser");
            return;
        }

        this.videoFormat = getDefaultVideoFormat(encodingSupport);
        const formatOptions = getFilteredVideoFormatOptions(encodingSupport);

        this.renderVideoFolder = parentFolder.addFolder("Video Render & Export").close()
            .tooltip("Options for rendering and exporting video files from Sitrec views or full viewport");

        if (exportableViews.length > 0) {
            this.renderVideoFolder.add(this, "videoExportView", exportableViews)
                .name("Render Video View")
                .tooltip("Select which view to export as video");

            this.renderVideoFolder.add({
                exportVideo: () => {
                    const view = ViewMan.get(this.videoExportView, false);
                    if (view && view.exportVideo) {
                        view.exportVideo(this.videoFormat, this.exportAudio);
                    }
                }
            }, "exportVideo").name("Render Single View Video")
                .tooltip("Export the selected view as a video file with all frames");
        }

        if (Object.keys(formatOptions).length > 1) {
            this.renderVideoFolder.add(this, "videoFormat", formatOptions)
                .name("Video Format")
                .tooltip("Select the output video format");
        }

        this.renderVideoFolder.add({
            exportViewport: () => this.exportViewportVideo()
        }, "exportViewport").name("Render Viewport Video")
            .tooltip("Export the entire viewport as a video file with all frames");

        this.renderVideoFolder.add({
            exportFullscreenViewport: () => this.exportFullscreenViewportVideo()
        }, "exportFullscreenViewport").name("Render Fullscreen Video")
            .tooltip("Export the entire viewport in fullscreen mode as a video file with all frames");

        this.renderVideoFolder.add({
            exportWindow: () => this.exportWindowVideo()
        }, "exportWindow").name("Record Browser Window")
            .tooltip("Record the entire browser window (including menus and UI) as a video with locked framerate");

        this.renderVideoFolder.add(this, "retinaExport")
            .name("Use HD/Retina Export")
            .tooltip("Export at retina/HiDPI resolution (2x on most displays)");

        this.renderVideoFolder.add(this, "exportAudio")
            .name("Include Audio")
            .tooltip("Include audio track from source video if available");

        this.renderVideoFolder.add({
            exportFrame: () => this.exportVideoFrame()
        }, "exportFrame").name("Export Video Frame")
            .tooltip("Export the current video frame as displayed (with effects) as a PNG file");

        if (!options.skipPanorama) {
            setupPanoramaExport(this.renderVideoFolder);
        }

        return this.renderVideoFolder;
    }

    async exportVideoFrame() {
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
        const fileName = `${getExportPrefix()}_frame_${String(frame).padStart(5, "0")}.png`;

        videoView.canvas.toBlob((blob) => {
            if (blob) {
                saveAs(blob, fileName);
            }
        }, "image/png");
    }

    async exportViewportVideo() {
        const { ViewMan } = await import("./CViewManager");
        const { GlobalDateTimeNode, NodeMan, Sit, Globals, setRenderOne } = await import("./Globals");
        const { par } = await import("./par");
        const { GlobalScene, LocalFrame } = await import("./LocalFrame");
        const { Frame2Az, Frame2El, UpdatePRFromEA } = await import("./JetStuff");
        const { ExportProgressWidget, drawVideoWatermark } = await import("./utils");
        const { getMotionAnalysisOverlays } = await import("./CMotionAnalysis");
        const { CNodeView3D } = await import("./nodes/CNodeView3D");

        const startFrame = Sit.aFrame;
        const endFrame = Sit.bFrame;
        const totalFrames = endFrame - startFrame + 1;
        const scale = this.retinaExport ? (window.devicePixelRatio || 1) : 1;
        const width = Math.round(ViewMan.widthPx * scale);
        const height = Math.round(ViewMan.heightPx * scale);
        const fps = Sit.fps;

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

        console.log(`Starting viewport video export (${formatId}): ${totalFrames} frames (${startFrame}-${endFrame}) at ${fps} fps, ${width}x${height} (scale: ${scale}x)`);

        const savedFrame = par.frame;
        const savedPaused = par.paused;
        par.paused = true;

        const progress = new ExportProgressWidget('Exporting viewport video...', totalFrames);

        const compositeCanvas = document.createElement('canvas');
        compositeCanvas.width = width;
        compositeCanvas.height = height;
        const compositeCtx = compositeCanvas.getContext('2d');

        const videoStartDate = GlobalDateTimeNode ? GlobalDateTimeNode.frameToDate(startFrame) : null;

        let audioBuffer = null;
        let audioStartTime = 0;
        let audioDuration = null;
        let originalFps = fps;

        if (this.exportAudio) {
            for (const entry of Object.values(NodeMan.list)) {
                const node = entry.data;
                if (node.videoData && node.videoData.audioHandler &&
                    node.videoData.audioHandler.decodingComplete) {
                    const exportAudioBuffer = node.videoData.audioHandler.getAudioBufferForExport();
                    if (exportAudioBuffer) {
                        audioBuffer = exportAudioBuffer;
                        originalFps = node.videoData.audioHandler.originalFps || fps;
                        audioStartTime = startFrame / originalFps;
                        audioDuration = totalFrames / fps;
                        console.log(`Found audio: ${audioBuffer.duration.toFixed(2)}s, using ${audioDuration.toFixed(2)}s from ${audioStartTime.toFixed(2)}s`);
                        break;
                    }
                }
            }
        }

        try {
            const exporter = await createVideoExporter(formatId, {
                width,
                height,
                fps,
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

            for (let i = 0; i < totalFrames; i++) {
                if (progress.shouldStop()) break;

                const frame = startFrame + i;
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

                ViewMan.computeEffectiveVisibility();

                ViewMan.iterate((id, view) => {
                    if (view._effectivelyVisible) {
                        if (view.overlayView) {
                            overlays.push(view);
                        } else {
                            nonOverlays.push(view);
                        }
                    }
                });

                for (const view of nonOverlays) {
                    if (view.camera && view instanceof CNodeView3D) {
                        view.camera.updateMatrix();
                        view.camera.updateMatrixWorld();
                        for (const entry of Object.values(NodeMan.list)) {
                            const node = entry.data;
                            if (node.preRender !== undefined) {
                                node.preRender(view);
                            }
                        }
                    }
                    view.renderCanvas(frame);
                    for (const entry of Object.values(NodeMan.list)) {
                        const node = entry.data;
                        if (node.postRender !== undefined) {
                            node.postRender(view);
                        }
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

                    if (view.canvas) {
                        const ctx = view.canvas.getContext('2d');
                        ctx.clearRect(0, 0, view.canvas.width, view.canvas.height);
                    }
                    if (view.camera && view instanceof CNodeView3D) {
                        view.camera.updateMatrix();
                        view.camera.updateMatrixWorld();
                        for (const entry of Object.values(NodeMan.list)) {
                            const node = entry.data;
                            if (node.preRender !== undefined) {
                                node.preRender(view);
                            }
                        }
                    }
                    view.renderCanvas(frame);
                    for (const entry of Object.values(NodeMan.list)) {
                        const node = entry.data;
                        if (node.postRender !== undefined) {
                            node.postRender(view);
                        }
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
                const filename = `${getExportPrefix()}_viewport_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${extension}`;
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
        const totalFrames = endFrame - startFrame + 1;
        const fps = Sit.fps;

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

        console.log(`Starting window video export (${formatId}): ${totalFrames} frames (${startFrame}-${endFrame}) at ${fps} fps, ${width}x${height}`);

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
        let originalFps = fps;

        if (this.exportAudio) {
            for (const entry of Object.values(NodeMan.list)) {
                const node = entry.data;
                if (node.videoData && node.videoData.audioHandler &&
                    node.videoData.audioHandler.decodingComplete) {
                    const exportAudioBuffer = node.videoData.audioHandler.getAudioBufferForExport();
                    if (exportAudioBuffer) {
                        audioBuffer = exportAudioBuffer;
                        originalFps = node.videoData.audioHandler.originalFps || fps;
                        audioStartTime = startFrame / originalFps;
                        audioDuration = totalFrames / fps;
                        break;
                    }
                }
            }
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
                fps,
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

            for (let i = 0; i < totalFrames; i++) {
                if (stopEarly || abortExport) break;
                if (videoTrack.readyState !== 'live') {
                    console.warn('Display capture stream ended');
                    break;
                }

                const frame = startFrame + i;
                par.frame = frame;
                if (GlobalDateTimeNode) GlobalDateTimeNode.update(frame);

                for (const entry of Object.values(NodeMan.list)) {
                    const node = entry.data;
                    if (node.videoData && node.videoData.waitForFrame) {
                        await node.videoData.waitForFrame(frame);
                    }
                }

                setRenderOne(true);
                await waitForPaint();

                captureCtx.fillStyle = '#000000';
                captureCtx.fillRect(0, 0, width, height);
                captureCtx.drawImage(videoEl, 0, 0, width, height);

                drawVideoWatermark(captureCtx, width);

                await exporter.addFrame(captureCanvas, frame);

                if (i % 10 === 0) {
                    document.title = `Recording ${i + 1}/${totalFrames} [Enter=save, Esc=abort]`;
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
                const filename = `${getExportPrefix()}_window_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.${extension}`;
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
