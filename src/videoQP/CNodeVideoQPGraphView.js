// CNodeVideoQPGraphView - graph of the H.264 quantization parameter (QP) of the
// loaded video: the maximum, mean and minimum macroblock QP of every frame.
//
// QP sets how coarsely the encoder quantized a 16x16 macroblock. A higher QP is
// more loss. The encoder can change QP for each macroblock, so one frame has a
// range of values. The values come from the bitstream itself (H264QPParser.js),
// not from an estimate made from the pixels.
//
// This file is NOT in src/nodes/ on purpose. That directory is bundled as a whole
// (RegisterNodes require.context). This view is loaded on first use only.

import {CNodeCustomGraphView} from "../nodes/CNodeCustomGraphView";
import {CNodeTabbedCanvasView} from "../nodes/CNodeTabbedCanvasView";
import {NodeMan, setRenderOne, Sit} from "../Globals";
import {par} from "../par";
import {t} from "../i18n";
import {VideoLoadingManager} from "../CVideoLoadingManager";
import {seriesThemeColor} from "../ThemeColors";
import {analyzeVideoQP, displayIndexForFrame, getVideoQPResult, sourceVideoOf, whyNotAnalyzable} from "./VideoQPAnalysis";

const MARGIN = 60;
const DARK = {bg: "#000", frame: "#444", grid: "#333", text: "#ddd", title: "#fff", crosshair: "#ff0"};
const LIGHT = {bg: "#fff", frame: "#aaa", grid: "#ddd", text: "#333", title: "#000", crosshair: "#c80"};

// The plotted series, in draw order (the mean is on top). "values" is the field of the
// analysis result. Each series registers a color for the dark theme and can register one
// for the light theme. The mean has no light color: white becomes black by calculation
// (ThemeColors.js).
const SERIES = [
    {values: "max", label: "videoQP.legend.max", dark: "#f08020", light: "#c25400"},
    {values: "min", label: "videoQP.legend.min", dark: "#2a8cf0", light: "#0a4fb4"},
    {values: "mean", label: "videoQP.legend.mean", dark: "#ffffff"},
];
// legend and readout order, as in the source figure
const LEGEND_ORDER = ["max", "mean", "min"];

export class CNodeVideoQPGraphView extends CNodeCustomGraphView {
    constructor(v) {
        super(v);
        // The view is made on demand, so a saved node mod could never attach again
        // on load. VideoQPGraph.js saves and restores its state.
        this.skipModSerialize = true;
        this.isFrameX = true;
        this.xLabel = t("videoQP.xLabel");
        this.minY = 0;
        this.maxY = 50;
        this._plot = null;      // cached drawing of the three lines
        this._plotKey = "";
    }

    currentVideoData() {
        return NodeMan.get("video", false)?.videoData ?? null;
    }

    // The analysis result of the current video (see VideoQPAnalysis.js), or null.
    qpResult() {
        return getVideoQPResult(this.currentVideoData());
    }

    dispose() {
        clearTimeout(this._loadPoll);
        this._plot = null;
        super.dispose();
    }

    // The base class calls this on a size change. The axes here do not follow the data.
    autoScale() {
        const last = Math.max(1, (Sit.frames ?? 1) - 1);
        this.minX = 0;
        this.maxX = last;
        this.minY = 0;
        const result = getVideoQPResult(this.currentVideoData());
        let top = 50;
        if (result) {
            for (let i = 0; i < result.frames; i++) if (result.max[i] > top) top = result.max[i];
        }
        this.maxY = Math.ceil(top / 5) * 5;
        this.hasY2 = false;
        this.hasY3 = false;
    }

    // The encoded chunks arrive progressively. The analysis needs all of them.
    isStillLoading(videoData) {
        const source = sourceVideoOf(videoData);
        return !!source?._loadingId && VideoLoadingManager.isLoading(source._loadingId);
    }

    // Starts the analysis of the current video, if it is not started.
    ensureAnalysis(videoData) {
        if (this.isStillLoading(videoData)) {
            // nothing else makes a new render when the load completes
            if (!this._loadPoll) {
                this._loadPoll = setTimeout(() => {
                    this._loadPoll = null;
                    this._plotKey = "";
                    setRenderOne();
                }, 500);
            }
            return;
        }
        if (whyNotAnalyzable(videoData)) return;
        const source = sourceVideoOf(videoData);
        if (this._requested === source) return;
        this._requested = source;
        analyzeVideoQP(videoData, () => setRenderOne());
    }

    statusMessage(videoData, result) {
        if (this.isStillLoading(videoData)) return t("videoQP.status.loading");
        const reason = whyNotAnalyzable(videoData);
        if (reason) return t("videoQP.status." + reason);
        if (result?.error) {
            return result.error.unsupported
                ? t("videoQP.status.unsupported", {reason: result.error.message})
                : t("videoQP.status.failed", {reason: result.error.message});
        }
        if (result && !result.complete) {
            return t("videoQP.status.analyzing", {percent: Math.floor(100 * result.done / Math.max(1, result.frames))});
        }
        return null;
    }

    renderCanvas(frame) {
        if (!this.visible) return;

        const videoData = this.currentVideoData();
        this.ensureAnalysis(videoData);
        const result = getVideoQPResult(videoData);

        const width = this.widthPx;
        const height = this.heightPx;
        const key = [width, height, this.dark, result?.version ?? -1, Sit.frames, sourceVideoOf(videoData)?.id ?? ""].join("|");
        if (key !== this._plotKey) {
            this._plotKey = key;
            this.autoScale();
            this._plot = this.drawPlot(videoData, result, width, height);
        }

        CNodeTabbedCanvasView.prototype.renderCanvas.call(this, frame);
        const ctx = this.ctx;
        if (!this._plot) {
            ctx.fillStyle = (this.dark ? DARK : LIGHT).bg;
            ctx.fillRect(0, 0, width, height);
            return;
        }
        ctx.drawImage(this._plot, 0, 0);
        this.drawCursor(ctx, videoData, result, width, height);
    }

    // Everything that does not change with the current frame, drawn once into a canvas.
    drawPlot(videoData, result, width, height) {
        if (width < MARGIN * 2 + 10 || height < MARGIN * 2 + 10) return null;
        const canvas = document.createElement("canvas");
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext("2d");
        const c = this.dark ? DARK : LIGHT;
        const graphWidth = width - MARGIN * 2;
        const graphHeight = height - MARGIN * 2;

        ctx.fillStyle = c.bg;
        ctx.fillRect(0, 0, width, height);

        ctx.font = "14px sans-serif";
        ctx.textAlign = "center";
        ctx.fillStyle = c.title;
        const blocks = result?.mbWidth ? result.mbWidth * result.mbHeight : 0;
        const fileName = String(NodeMan.get("video", false)?.fileName ?? "");
        let name = fileName.split(/[\\/]/).pop().split("?")[0];
        try {
            name = decodeURIComponent(name);
        } catch (e) {
            // a name with a bare "%" is not URL-encoded: show it as it is
        }
        ctx.fillText(blocks
            ? t("videoQP.titleBlocks", {name, blocks})
            : t("videoQP.title"), width / 2, 18);

        ctx.strokeStyle = c.frame;
        ctx.lineWidth = 1;
        ctx.strokeRect(MARGIN, MARGIN, graphWidth, graphHeight);

        // grid and axis numbers
        const xStep = this.calculateStep(this.maxX - this.minX, graphWidth);
        const yStep = this.calculateStep(this.maxY - this.minY, graphHeight);
        ctx.font = "12px sans-serif";
        ctx.strokeStyle = c.grid;
        ctx.fillStyle = c.text;
        for (let x = Math.ceil(this.minX / xStep) * xStep; x <= this.maxX; x += xStep) {
            const s = this.graphToScreenAxis(x, this.minY, this.minY, this.maxY);
            ctx.beginPath(); ctx.moveTo(s.x, MARGIN); ctx.lineTo(s.x, MARGIN + graphHeight); ctx.stroke();
            ctx.textAlign = "center";
            ctx.fillText(Math.round(x).toString(), s.x, MARGIN + graphHeight + 20);
        }
        for (let y = Math.ceil(this.minY / yStep) * yStep; y <= this.maxY; y += yStep) {
            const s = this.graphToScreenAxis(this.minX, y, this.minY, this.maxY);
            ctx.beginPath(); ctx.moveTo(MARGIN, s.y); ctx.lineTo(MARGIN + graphWidth, s.y); ctx.stroke();
            ctx.textAlign = "right";
            ctx.fillText(Math.round(y).toString(), MARGIN - 5, s.y + 4);
        }

        // axis titles
        ctx.font = "14px sans-serif";
        ctx.fillStyle = c.title;
        ctx.textAlign = "center";
        ctx.fillText(this.xLabel, MARGIN + graphWidth / 2, height - 10);
        ctx.save();
        ctx.translate(16, MARGIN + graphHeight / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(t("videoQP.yLabel"), 0, 0);
        ctx.restore();

        const message = this.statusMessage(videoData, result);
        if (result && !result.error) {
            ctx.save();
            ctx.beginPath();
            ctx.rect(MARGIN, MARGIN, graphWidth, graphHeight);
            ctx.clip();
            for (const series of SERIES) {
                this.drawLine(ctx, videoData, result[series.values], seriesThemeColor(series, this.dark));
            }
            ctx.restore();
            if (this.showLegend) this.drawLegend(ctx, c, width, height);
        }
        if (message) {
            ctx.font = "13px sans-serif";
            ctx.textAlign = "center";
            ctx.fillStyle = c.text;
            ctx.fillText(message, MARGIN + graphWidth / 2, result && !result.error ? MARGIN + 18 : MARGIN + graphHeight / 2);
        }
        return canvas;
    }

    // One value for each sitch frame, no smoothing. A frame with no data breaks the line.
    drawLine(ctx, videoData, values, color) {
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.beginPath();
        let drawing = false;
        const frames = Sit.frames ?? values.length;
        for (let f = 0; f < frames; f++) {
            const v = values[displayIndexForFrame(videoData, f)];
            if (!(v >= 0)) { // NaN or undefined
                drawing = false;
                continue;
            }
            const s = this.graphToScreenAxis(f, v, this.minY, this.maxY);
            if (drawing) ctx.lineTo(s.x, s.y);
            else ctx.moveTo(s.x, s.y);
            drawing = true;
        }
        ctx.stroke();
    }

    drawLegend(ctx, c, width, height) {
        const entries = LEGEND_ORDER.map((values) => {
            const series = SERIES.find((s) => s.values === values);
            return [seriesThemeColor(series, this.dark), t(series.label)];
        });
        ctx.font = "12px sans-serif";
        ctx.textAlign = "left";
        let total = 0;
        for (const entry of entries) total += 34 + ctx.measureText(entry[1]).width + 14;
        let x = width - MARGIN - total - 4;
        const y = height - MARGIN - 12;
        ctx.fillStyle = this.dark ? "rgba(0,0,0,0.75)" : "rgba(255,255,255,0.85)";
        ctx.fillRect(x - 6, y - 12, total + 8, 22);
        ctx.strokeStyle = c.frame;
        ctx.strokeRect(x - 6, y - 12, total + 8, 22);
        for (const [color, label] of entries) {
            ctx.strokeStyle = color;
            ctx.lineWidth = 2;
            ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 26, y); ctx.stroke();
            ctx.fillStyle = c.text;
            ctx.fillText(label, x + 32, y + 4);
            x += 34 + ctx.measureText(label).width + 14;
        }
        ctx.lineWidth = 1;
    }

    // The current-frame line, and the values of the current frame
    drawCursor(ctx, videoData, result, width, height) {
        const c = this.dark ? DARK : LIGHT;
        const current = Math.floor(par.frame);
        if (current < this.minX || current > this.maxX) return;
        const s = this.graphToScreenAxis(current, this.minY, this.minY, this.maxY);
        ctx.strokeStyle = c.crosshair;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(s.x, MARGIN); ctx.lineTo(s.x, height - MARGIN); ctx.stroke();

        if (!result || result.error) return;
        const index = displayIndexForFrame(videoData, current);
        const mean = result.mean[index];
        if (!(mean >= 0)) return;
        for (const series of SERIES) {
            const p = this.graphToScreenAxis(current, result[series.values][index], this.minY, this.maxY);
            ctx.fillStyle = seriesThemeColor(series, this.dark);
            ctx.beginPath(); ctx.arc(p.x, p.y, 4, 0, Math.PI * 2); ctx.fill();
        }
        ctx.font = "12px sans-serif";
        ctx.textAlign = "left";
        ctx.fillStyle = c.text;
        ctx.fillText(t("videoQP.readout", {
            frame: current,
            max: result.max[index], mean: mean.toFixed(1), min: result.min[index],
            type: result.pictureType[index], sliceQP: result.sliceQP[index],
        }), MARGIN, MARGIN - 8);
    }
}

export function createVideoQPGraphView(id) {
    return new CNodeVideoQPGraphView({
        id,
        menuName: t("videoQP.title"),
        showLegend: true,
        visible: true,
        left: 0.30, top: 0.50, width: 0.45, height: 0.40,
        draggable: true, resizable: true, freeAspect: true, shiftDrag: false,
    });
}
