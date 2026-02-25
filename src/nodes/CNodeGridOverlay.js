import {CNodeViewCanvas2D} from "./CNodeViewCanvas";
import {setRenderOne} from "../Globals";

export class CNodeGridOverlay extends CNodeViewCanvas2D {
    constructor(v) {
        super(v);
        this.autoClear = true;
        this.separateVisibility = true;
        this.visible = false;
        this.ignoreMouseEvents();

        this.gridSize = 64;
        this.gridSubdivisions = 4;
        this.gridXOffset = 0;
        this.gridYOffset = 0;
        this.gridColor = "#00D000";
        this.gridShow = false;

        this.addSimpleSerials(["gridSize", "gridSubdivisions", "gridXOffset", "gridYOffset", "gridColor", "gridShow"]);
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        this.visible = this.gridShow;
    }

    setShow(show) {
        this.show(show);
        setRenderOne(true);
    }

    renderCanvas(frame) {
        if (!this.visible) return;

        super.renderCanvas(frame);

        if (!this.visible) return;

        const ctx = this.ctx;
        ctx.clearRect(0, 0, this.widthPx, this.heightPx);

        const videoView = this.overlayView;
        if (!videoView) return;

        const vw = videoView.videoWidth;
        const vh = videoView.videoHeight;
        if (!vw || !vh) return;

        videoView.getSourceAndDestCoords();
        const {dx, dy, dWidth, dHeight, sx, sy, sWidth, sHeight} = videoView;

        if (dWidth <= 0 || dHeight <= 0) return;

        const size = this.gridSize;
        const subdivisions = this.gridSubdivisions;
        const xOff = this.gridXOffset;
        const yOff = this.gridYOffset;

        const scaleX = dWidth / sWidth;
        const scaleY = dHeight / sHeight;

        const v2cx = (vx) => dx + (vx - sx) * scaleX;
        const v2cy = (vy) => dy + (vy - sy) * scaleY;

        const visMinX = sx;
        const visMaxX = sx + sWidth;
        const visMinY = sy;
        const visMaxY = sy + sHeight;

        ctx.save();

        ctx.beginPath();
        ctx.rect(dx, dy, dWidth, dHeight);
        ctx.clip();

        const screenSpacing = (step) => Math.min(step * scaleX, step * scaleY);
        const fadeAlpha = (step) => Math.max(0, Math.min(1, (screenSpacing(step) - 2) / (4 - 2)));

        const drawLines = (step, lineWidth, skipStep) => {
            const alpha = fadeAlpha(step);
            if (alpha <= 0) return;

            ctx.globalAlpha = alpha;
            ctx.strokeStyle = this.gridColor;
            ctx.lineWidth = lineWidth;
            ctx.beginPath();

            const firstVX = Math.ceil((visMinX - xOff) / step) * step + xOff;
            for (let vx = firstVX; vx <= visMaxX; vx += step) {
                if (skipStep) {
                    const rel = ((vx - xOff) % skipStep + skipStep) % skipStep;
                    if (Math.abs(rel) < 0.001 || Math.abs(rel - skipStep) < 0.001) continue;
                }
                const cx = v2cx(vx);
                ctx.moveTo(cx, dy);
                ctx.lineTo(cx, dy + dHeight);
            }

            const firstVY = Math.ceil((visMinY - yOff) / step) * step + yOff;
            for (let vy = firstVY; vy <= visMaxY; vy += step) {
                if (skipStep) {
                    const rel = ((vy - yOff) % skipStep + skipStep) % skipStep;
                    if (Math.abs(rel) < 0.001 || Math.abs(rel - skipStep) < 0.001) continue;
                }
                const cy = v2cy(vy);
                ctx.moveTo(dx, cy);
                ctx.lineTo(dx + dWidth, cy);
            }

            ctx.stroke();
            ctx.globalAlpha = 1;
        };

        if (subdivisions > 1) {
            const subSize = size / subdivisions;
            drawLines(subSize, 0.5, size);
        }

        drawLines(size, 1, null);

        ctx.restore();
    }
}
