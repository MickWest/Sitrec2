import {AnalogVideoFilter} from "./AnalogVideoFilter";
import {compositeVideoFormatHost, videoFormatOSDViews} from "./VideoFormatLayer";
import {getCanvasDisplayRect} from "../VideoExporter";

// A private filter for one export. Capture source pixels synchronously with the
// view renders, then filter only the final, settled frame just before encoding.
export class VideoFormatExportLayer {
    constructor(host, {width, height, fps, settings}) {
        this.host = host;
        this.source = document.createElement("canvas");
        this.source.width = width;
        this.source.height = height;
        this.foreground = document.createElement("canvas");
        this.foreground.width = width;
        this.foreground.height = height;
        this.filter = new AnalogVideoFilter({width, height, fps, settings});
        this.captured = false;
    }

    capture(orderedViews = []) {
        const host = this.host;
        this.captured = host._effectivelyVisible && host.widthPx > 0 && host.heightPx > 0;
        if (!this.captured) return;
        const osd = videoFormatOSDViews(host);
        compositeVideoFormatHost(host, this.source, osd);

        // The live layer sits above the host and its HUD, but below higher views.
        // Preserve any such views before their WebGL drawing buffers are cleared.
        const zIndex = Math.max(host.zIndex || 0, ...osd.map(view => view.zIndex || 0));
        const ctx = this.foreground.getContext("2d");
        ctx.clearRect(0, 0, this.foreground.width, this.foreground.height);
        const sx = this.source.width / host.widthPx;
        const sy = this.source.height / host.heightPx;
        for (const view of orderedViews) {
            const parent = view.overlayView ?? view;
            if (parent === host || osd.includes(view) || (parent.zIndex || 0) <= zIndex) continue;
            if (!view.canvas?.width || !view.canvas?.height) continue;
            if (view.canvas.style.display === "none" || view.canvas.style.visibility === "hidden") continue;
            const alpha = view.transparency ?? 1;
            if (alpha <= 0) continue;
            const rect = view.overlayView
                ? {x: 0, y: 0, width: parent.widthPx, height: parent.heightPx}
                : getCanvasDisplayRect(view);
            ctx.globalAlpha = alpha;
            ctx.drawImage(view.canvas,
                (parent.leftPx + rect.x - host.leftPx) * sx,
                (parent.topPx + rect.y - host.topPx) * sy,
                rect.width * sx, rect.height * sy);
        }
        ctx.globalAlpha = 1;
    }

    draw(ctx, x, y, width, height) {
        if (!this.captured) return;
        ctx.drawImage(this.filter.filterFrame(this.source), x, y, width, height);
        ctx.drawImage(this.foreground, x, y, width, height);
    }

    dispose() {
        this.filter.dispose();
    }
}
