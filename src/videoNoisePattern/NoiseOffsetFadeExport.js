import {createVideoExporter, checkCodecAtResolution} from "../VideoExporter";
import {sourceVideoOf} from "../videoQP/VideoQPAnalysis";
import {t} from "../i18n";
import {yieldVideoExportTask} from "../MediabunnyExporter.js";

export const OFFSET_FADE_FPS = 30;
export const OFFSET_FADE_FRAMES = 120;

// Sample at frame midpoints: 0.5 s source, 1 s fade, 0.5 s target,
// followed by the exact reverse of those 60 frames.
export function overlapFadeTargetWeight(frame) {
    const forwardFrame = frame < 60 ? frame : OFFSET_FADE_FRAMES - 1 - frame;
    return Math.max(0, Math.min(1, (forwardFrame + 0.5) / OFFSET_FADE_FPS - 0.5));
}

export function centeredOffsetFrame(image, width, height, x, y, roiWidth, roiHeight) {
    const canvas = document.createElement("canvas");
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000"; ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingEnabled = false;
    // Native pixels, translation only. The output viewport clips the shifted frame.
    ctx.drawImage(image, width / 2 - (x + roiWidth / 2), height / 2 - (y + roiHeight / 2));
    return canvas;
}

export async function exportNoiseOffsetFade({videoData, match, width, height, onProgress = () => {}, isCancelled = () => false}) {
    const source = sourceVideoOf(videoData);
    const checkCancelled = () => {
        if (isCancelled()) throw new DOMException("Export cancelled", "AbortError");
    };
    const fail = (key, values) => new Error(t(`videoNoisePattern.exportFade.${key}`, values));
    if (!source || ![width, height, match?.source, match?.target, match?.x, match?.y, match?.tx, match?.ty, match?.width, match?.height].every(Number.isFinite)
        || width <= 0 || height <= 0 || match.width <= 0 || match.height <= 0) throw fail("invalid");
    const outputWidth = Math.ceil(width / 2) * 2, outputHeight = Math.ceil(height / 2) * 2;
    let exporter, a, b, canvas;
    try {
        const support = await checkCodecAtResolution("mp4-h264", outputWidth, outputHeight);
        checkCancelled();
        if (!support.supported) throw fail("unsupported", {reason: support.reason});
        const capture = async (display, x, y) => {
            // The detector's display indices refer to the underlying source video,
            // before patched timelines, stabilization or playback adjustments.
            const frame = display * (source.videoSpeed || 1);
            let image = source.getImageNoPurge?.(frame);
            if (!image) {
                await source.waitForFrame?.(frame);
                checkCancelled();
                image = source.getImageNoPurge?.(frame);
            }
            if (!image) throw fail("frameUnavailable", {frame: display});
            if (image.width !== width || image.height !== height) throw fail("dimensions");
            // Copy before requesting the other frame: decoding may evict this cache entry.
            return centeredOffsetFrame(image, outputWidth, outputHeight, x, y, match.width, match.height);
        };
        a = await capture(match.source, match.x, match.y);
        checkCancelled();
        b = await capture(match.target, match.tx, match.ty);
        checkCancelled();
        canvas = document.createElement("canvas"); canvas.width = outputWidth; canvas.height = outputHeight;
        const ctx = canvas.getContext("2d");
        exporter = await createVideoExporter("mp4-h264", {
            width: outputWidth, height: outputHeight, fps: OFFSET_FADE_FPS,
            bitrate: 20_000_000, keyFrameInterval: OFFSET_FADE_FPS,
            hardwareAcceleration: support.hardwareAcceleration,
        });
        await exporter.initialize();
        for (let i = 0; i < OFFSET_FADE_FRAMES; i++) {
            checkCancelled();
            ctx.globalAlpha = 1; ctx.drawImage(a, 0, 0);
            ctx.globalAlpha = overlapFadeTargetWeight(i); ctx.drawImage(b, 0, 0);
            ctx.globalAlpha = 1;
            await exporter.addFrame(canvas, i);
            onProgress(i + 1, OFFSET_FADE_FRAMES);
            if (i % 10 === 0) await yieldVideoExportTask();
        }
        checkCancelled();
        const blob = await exporter.finalize();
        checkCancelled();
        return {blob, width: outputWidth, height: outputHeight, fps: OFFSET_FADE_FPS, frames: OFFSET_FADE_FRAMES, duration: 4};
    } finally {
        await exporter?.dispose();
        for (const image of [a, b, canvas]) if (image) { image.width = 0; image.height = 0; }
    }
}
