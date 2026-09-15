// Locate the whole source image, including any area outside a zoomed/panned pane.
// The clipped video destination rectangle cannot locate the sensor boresight.
export function getHUDImageRect(widthPx, heightPx, videoView, maxAspect = 16 / 9) {
    if (videoView?.videoWidth > 0 && videoView.videoHeight > 0 && videoView.videoToCanvasCoords) {
        const [x0, y0] = videoView.videoToCanvasCoords(0, 0);
        const [x1, y1] = videoView.videoToCanvasCoords(videoView.videoWidth, videoView.videoHeight);
        const scaleX = widthPx / videoView.widthPx;
        const scaleY = heightPx / videoView.heightPx;
        if ([x0, y0, x1, y1, scaleX, scaleY].every(Number.isFinite) && x1 > x0 && y1 > y0) {
            return {x: x0 * scaleX, y: y0 * scaleY, width: (x1 - x0) * scaleX, height: (y1 - y0) * scaleY};
        }
    }
    const width = Math.min(widthPx, heightPx * maxAspect);
    return {x: (widthPx - width) / 2, y: 0, width, height: heightPx};
}
