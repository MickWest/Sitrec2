import {CNodeViewCanvas2D} from "./CNodeViewCanvas";
import {setRenderOne} from "../Globals";
import {getClipComparisonValue} from "./CNodeVideoViewFilters";

const HISTOGRAM_BINS = 256;

export class CNodeVideoHistogramView extends CNodeViewCanvas2D {
    constructor(v) {
        super({
            visible: false,
            background: [0, 0, 0, 0],
            draggable: true,
            resizable: true,
            freeAspect: true,
            doubleClickFullScreen: false,
            excludeFromViewsMenu: true,
            alwaysOnTop: true,
            ...v,
        });

        this.videoView = v.videoView;
        this.sampleCanvas = document.createElement("canvas");
        this.sampleCanvas.width = HISTOGRAM_BINS;
        this.sampleCanvas.height = HISTOGRAM_BINS;
        this.sampleCtx = this.sampleCanvas.getContext("2d", {willReadFrequently: true});
        this.originalSampleCanvas = document.createElement("canvas");
        this.originalSampleCanvas.width = HISTOGRAM_BINS;
        this.originalSampleCanvas.height = HISTOGRAM_BINS;
        this.originalSampleCtx = this.originalSampleCanvas.getContext("2d", {willReadFrequently: true});
        this.red = new Uint32Array(HISTOGRAM_BINS);
        this.green = new Uint32Array(HISTOGRAM_BINS);
        this.blue = new Uint32Array(HISTOGRAM_BINS);
        this.tonalLossStats = null;
        this.lastFrame = -1;
        this.lastVideoData = null;
        this.shadowWarningEnabled = false;
        this.highlightWarningEnabled = false;
        this.shadowIndicatorRect = null;
        this.highlightIndicatorRect = null;
        this.div.style.border = "1px solid rgba(255,255,255,0.22)";
        this.div.style.boxShadow = "0 2px 8px rgba(0,0,0,0.45)";
        this.canvas.style.pointerEvents = "none";
        this.tonalLossTooltipDiv = document.createElement("div");
        Object.assign(this.tonalLossTooltipDiv.style, {
            position: "absolute",
            display: "none",
            background: "transparent",
            cursor: "help",
            pointerEvents: "auto",
        });
        this.div.appendChild(this.tonalLossTooltipDiv);
        this.div.addEventListener("pointerdown", this.handlePointerDown, true);
    }

    dispose() {
        this.div?.removeEventListener("pointerdown", this.handlePointerDown, true);
        this.sampleCtx = null;
        this.sampleCanvas = null;
        this.originalSampleCtx = null;
        this.originalSampleCanvas = null;
        this.red = null;
        this.green = null;
        this.blue = null;
        this.tonalLossStats = null;
        this.tonalLossTooltipDiv?.remove();
        this.tonalLossTooltipDiv = null;
        super.dispose();
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            visible: false,
        };
    }

    handlePointerDown = (event) => {
        const local = this.eventToLocalPoint(event);
        if (this.rectContainsPoint(this.shadowIndicatorRect, local.x, local.y)) {
            this.toggleClipWarning("shadow");
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
        } else if (this.rectContainsPoint(this.highlightIndicatorRect, local.x, local.y)) {
            this.toggleClipWarning("highlight");
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
        }
    };

    eventToLocalPoint(event) {
        const rect = this.div.getBoundingClientRect();
        return {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
        };
    }

    rectContainsPoint(rect, x, y) {
        return !!rect && x >= rect.x && x <= rect.x + rect.size && y >= rect.y && y <= rect.y + rect.size;
    }

    toggleClipWarning(type) {
        if (type === "shadow") {
            this.shadowWarningEnabled = !this.shadowWarningEnabled;
        } else {
            this.highlightWarningEnabled = !this.highlightWarningEnabled;
        }
        this.videoView?.setClipWarningMaskEnabled?.(this.shadowWarningEnabled, this.highlightWarningEnabled);
        setRenderOne(true);
    }

    shouldRecalculate(frame) {
        return frame !== this.lastFrame || this.videoView?.videoData !== this.lastVideoData;
    }

    updateHistogram(frame) {
        const videoView = this.videoView;
        if (!videoView?.videoData) return false;

        videoView.videoData.update();
        const image = videoView.videoData.getImage(frame);
        if (!image) return false;

        const adjusted = videoView.getAdjustedVideoFrameSource
            ? videoView.getAdjustedVideoFrameSource(image, frame)
            : {sourceImage: image, filter: "none", fullABOverlay: null};

        const sourceImage = adjusted.sourceImage || image;
        const sourceWidth = sourceImage.videoWidth || sourceImage.naturalWidth || sourceImage.width;
        const sourceHeight = sourceImage.videoHeight || sourceImage.naturalHeight || sourceImage.height;
        if (!sourceWidth || !sourceHeight) return false;

        const scale = Math.min(1, HISTOGRAM_BINS / Math.max(sourceWidth, sourceHeight));
        const sampleWidth = Math.max(1, Math.round(sourceWidth * scale));
        const sampleHeight = Math.max(1, Math.round(sourceHeight * scale));

        if (this.sampleCanvas.width !== sampleWidth || this.sampleCanvas.height !== sampleHeight) {
            this.sampleCanvas.width = sampleWidth;
            this.sampleCanvas.height = sampleHeight;
        }

        this.drawSample(this.originalSampleCtx, image, sourceWidth, sourceHeight, sampleWidth, sampleHeight, "none", null);
        this.drawSample(this.sampleCtx, sourceImage, sourceWidth, sourceHeight, sampleWidth, sampleHeight, adjusted.filter || "none", adjusted.fullABOverlay);
        const originalData = this.originalSampleCtx.getImageData(0, 0, sampleWidth, sampleHeight).data;
        const data = this.sampleCtx.getImageData(0, 0, sampleWidth, sampleHeight).data;
        this.updateBinsAndClipping(originalData, data, adjusted.invertActive);

        this.lastFrame = frame;
        this.lastVideoData = videoView.videoData;
        return true;
    }

    drawSample(ctx, image, sourceWidth, sourceHeight, sampleWidth, sampleHeight, filter, fullABOverlay) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, sampleWidth, sampleHeight);
        ctx.globalAlpha = 1;
        ctx.imageSmoothingEnabled = true;
        ctx.filter = filter;
        ctx.drawImage(image, 0, 0, sourceWidth, sourceHeight, 0, 0, sampleWidth, sampleHeight);
        if (fullABOverlay) {
            ctx.filter = "none";
            ctx.globalAlpha = fullABOverlay.opacity;
            ctx.drawImage(fullABOverlay.image, 0, 0, sourceWidth, sourceHeight, 0, 0, sampleWidth, sampleHeight);
        }
        ctx.restore();
    }

    updateBinsAndClipping(originalData, data, invertActive = false) {
        this.red.fill(0);
        this.green.fill(0);
        this.blue.fill(0);

        const originalSeen = [
            new Uint8Array(HISTOGRAM_BINS),
            new Uint8Array(HISTOGRAM_BINS),
            new Uint8Array(HISTOGRAM_BINS),
        ];
        const adjustedSeen = [
            new Uint8Array(HISTOGRAM_BINS),
            new Uint8Array(HISTOGRAM_BINS),
            new Uint8Array(HISTOGRAM_BINS),
        ];
        const reverseMaps = [
            new Uint8Array(HISTOGRAM_BINS * HISTOGRAM_BINS),
            new Uint8Array(HISTOGRAM_BINS * HISTOGRAM_BINS),
            new Uint8Array(HISTOGRAM_BINS * HISTOGRAM_BINS),
        ];

        let shadowClipCount = 0;
        let highlightClipCount = 0;
        for (let i = 0; i < data.length; i += 4) {
            const alpha = data[i + 3];
            if (alpha === 0) continue;
            const r = data[i];
            const g = data[i + 1];
            const b = data[i + 2];
            const originalR = getClipComparisonValue(originalData[i], invertActive);
            const originalG = getClipComparisonValue(originalData[i + 1], invertActive);
            const originalB = getClipComparisonValue(originalData[i + 2], invertActive);
            this.red[r]++;
            this.green[g]++;
            this.blue[b]++;
            originalSeen[0][originalR] = 1;
            originalSeen[1][originalG] = 1;
            originalSeen[2][originalB] = 1;
            adjustedSeen[0][r] = 1;
            adjustedSeen[1][g] = 1;
            adjustedSeen[2][b] = 1;
            reverseMaps[0][r * HISTOGRAM_BINS + originalR] = 1;
            reverseMaps[1][g * HISTOGRAM_BINS + originalG] = 1;
            reverseMaps[2][b * HISTOGRAM_BINS + originalB] = 1;
            if ((r === 0 && originalR !== 0) || (g === 0 && originalG !== 0) || (b === 0 && originalB !== 0)) {
                shadowClipCount++;
            }
            if ((r === 255 && originalR !== 255) || (g === 255 && originalG !== 255) || (b === 255 && originalB !== 255)) {
                highlightClipCount++;
            }
        }

        this.shadowClipCount = shadowClipCount;
        this.highlightClipCount = highlightClipCount;
        this.shadowClipped = shadowClipCount > 0;
        this.highlightClipped = highlightClipCount > 0;
        this.tonalLossStats = this.calculateTonalLossStats(originalSeen, adjustedSeen, reverseMaps);
        this.updateTonalLossTooltip();
    }

    countSeen(seen) {
        let count = 0;
        for (let i = 0; i < HISTOGRAM_BINS; i++) {
            if (seen[i]) count++;
        }
        return count;
    }

    calculateTonalLossStats(originalSeen, adjustedSeen, reverseMaps) {
        let totalOriginalLevels = 0;
        let totalAdjustedLevels = 0;
        let totalCollapsedInputs = 0;
        let worstCollapse = 1;

        for (let channel = 0; channel < 3; channel++) {
            const originalLevels = this.countSeen(originalSeen[channel]);
            const adjustedLevels = this.countSeen(adjustedSeen[channel]);
            totalOriginalLevels += originalLevels;
            totalAdjustedLevels += adjustedLevels;

            const reverseMap = reverseMaps[channel];
            for (let out = 0; out < HISTOGRAM_BINS; out++) {
                let inputCount = 0;
                const rowOffset = out * HISTOGRAM_BINS;
                for (let input = 0; input < HISTOGRAM_BINS; input++) {
                    if (reverseMap[rowOffset + input]) inputCount++;
                }
                if (inputCount > 1) totalCollapsedInputs += inputCount - 1;
                if (inputCount > worstCollapse) worstCollapse = inputCount;
            }
        }

        if (totalOriginalLevels === 0) return null;

        const keptRatio = totalAdjustedLevels / totalOriginalLevels;
        const averageAdjustedLevels = totalAdjustedLevels / 3;
        return {
            keptPercent: Math.min(999, Math.round(keptRatio * 100)),
            effectiveBits: Math.log2(Math.max(1, averageAdjustedLevels)),
            collapsedInputs: totalCollapsedInputs,
            worstCollapse,
        };
    }

    updateTonalLossTooltip() {
        const stats = this.tonalLossStats;
        if (!stats) {
            if (this.tonalLossTooltipDiv) {
                this.tonalLossTooltipDiv.title = "";
                this.tonalLossTooltipDiv.style.display = "none";
            }
            this.div.removeAttribute("title");
            return;
        }

        if (!this.tonalLossTooltipDiv) return;
        this.div.removeAttribute("title");
        this.tonalLossTooltipDiv.title =
            "Tonal resolution after video adjustments\n" +
            `Levels ${stats.keptPercent}%: adjusted distinct RGB levels divided by original distinct RGB levels.\n` +
            `${stats.effectiveBits.toFixed(1)}b: effective tonal bit depth from the remaining output levels.\n` +
            `C${stats.collapsedInputs}: input levels that now share an output level, summed across RGB.\n` +
            `W${stats.worstCollapse}:1: worst many-to-one collapse for any output level.`;
    }

    maxBinValue() {
        let max = 1;
        for (let i = 0; i < HISTOGRAM_BINS; i++) {
            if (this.red[i] > max) max = this.red[i];
            if (this.green[i] > max) max = this.green[i];
            if (this.blue[i] > max) max = this.blue[i];
        }
        return max;
    }

    drawHistogramChannel(bins, color, fillColor, maxValue, left, top, width, height) {
        const ctx = this.ctx;
        const bottom = top + height;

        ctx.beginPath();
        ctx.moveTo(left, bottom);
        for (let i = 0; i < HISTOGRAM_BINS; i++) {
            const x = left + (i / (HISTOGRAM_BINS - 1)) * width;
            const y = bottom - (bins[i] / maxValue) * height;
            ctx.lineTo(x, y);
        }
        ctx.lineTo(left + width, bottom);
        ctx.closePath();
        ctx.fillStyle = fillColor;
        ctx.fill();

        ctx.beginPath();
        for (let i = 0; i < HISTOGRAM_BINS; i++) {
            const x = left + (i / (HISTOGRAM_BINS - 1)) * width;
            const y = bottom - (bins[i] / maxValue) * height;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = color;
        ctx.lineWidth = 1 / this.devicePixelRatio;
        ctx.stroke();
    }

    drawClippingIndicator(x, y, size, clipped, isHighlight, enabled) {
        const ctx = this.ctx;
        ctx.save();
        ctx.fillStyle = "rgba(0,0,0,0.62)";
        ctx.strokeStyle = enabled
            ? (isHighlight ? "rgba(255,44,44,0.98)" : "rgba(38,112,255,0.98)")
            : "rgba(255,255,255,0.35)";
        ctx.lineWidth = 1 / this.devicePixelRatio;
        ctx.fillRect(x, y, size, size);
        ctx.strokeRect(x, y, size, size);

        ctx.beginPath();
        if (isHighlight) {
            ctx.moveTo(x + size * 0.5, y + size * 0.22);
            ctx.lineTo(x + size * 0.82, y + size * 0.74);
            ctx.lineTo(x + size * 0.18, y + size * 0.74);
        } else {
            ctx.moveTo(x + size * 0.5, y + size * 0.78);
            ctx.lineTo(x + size * 0.18, y + size * 0.26);
            ctx.lineTo(x + size * 0.82, y + size * 0.26);
        }
        ctx.closePath();
        ctx.fillStyle = clipped
            ? (isHighlight ? "rgba(255,44,44,0.95)" : "rgba(38,112,255,0.95)")
            : "rgba(0,0,0,0.92)";
        ctx.fill();
        ctx.restore();
    }

    drawTonalLossStats(left, top, width) {
        const stats = this.tonalLossStats;
        if (!stats) return;

        const ctx = this.ctx;
        const text = `Levels ${stats.keptPercent}% | ${stats.effectiveBits.toFixed(1)}b | C${stats.collapsedInputs} | W${stats.worstCollapse}:1`;
        let fontSize = Math.max(9, Math.min(14, Math.round(this.heightPx * 0.08)));

        ctx.save();
        ctx.font = `600 ${fontSize}px sans-serif`;
        while (fontSize > 8 && ctx.measureText(text).width > width) {
            fontSize--;
            ctx.font = `600 ${fontSize}px sans-serif`;
        }
        const textWidth = ctx.measureText(text).width;
        this.positionTonalLossTooltip(left + width * 0.5, top, Math.min(width, textWidth + 8), fontSize + 5);
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillStyle = stats.collapsedInputs > 0
            ? "rgba(255,205,92,0.96)"
            : "rgba(210,235,255,0.90)";
        ctx.shadowColor = "rgba(0,0,0,0.85)";
        ctx.shadowBlur = 3;
        ctx.fillText(text, left + width * 0.5, top);
        ctx.restore();
    }

    positionTonalLossTooltip(centerX, top, width, height) {
        if (!this.tonalLossTooltipDiv) return;
        Object.assign(this.tonalLossTooltipDiv.style, {
            display: "block",
            left: `${centerX - width / 2}px`,
            top: `${top}px`,
            width: `${width}px`,
            height: `${height}px`,
        });
    }

    renderCanvas(frame = 0) {
        super.renderCanvas(frame);
        if (!this.visible) return;

        this.updateHistogram(frame);

        const ctx = this.ctx;
        const w = this.widthPx;
        const h = this.heightPx;
        if (w <= 0 || h <= 0) return;

        ctx.save();
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "rgba(33,33,33,0.90)";
        ctx.fillRect(0, 0, w, h);

        const pad = Math.max(4, Math.round(Math.min(w, h) * 0.035));
        const indicatorSize = Math.max(16, Math.min(30, Math.round(Math.min(w, h) * 0.18)));
        const graphTop = pad;
        const graphBottomPad = Math.max(3, pad * 0.6);
        const graphHeight = Math.max(1, h - graphTop - graphBottomPad);
        const graphLeft = pad;
        const graphWidth = Math.max(1, w - pad * 2);
        const maxValue = this.maxBinValue();

        this.drawHistogramChannel(this.red, "rgba(255,88,88,0.95)", "rgba(255,72,72,0.13)", maxValue, graphLeft, graphTop, graphWidth, graphHeight);
        this.drawHistogramChannel(this.green, "rgba(91,220,128,0.95)", "rgba(64,210,104,0.13)", maxValue, graphLeft, graphTop, graphWidth, graphHeight);
        this.drawHistogramChannel(this.blue, "rgba(74,135,255,0.95)", "rgba(56,115,255,0.13)", maxValue, graphLeft, graphTop, graphWidth, graphHeight);

        ctx.strokeStyle = "rgba(255,255,255,0.22)";
        ctx.lineWidth = 1 / this.devicePixelRatio;
        ctx.beginPath();
        ctx.moveTo(graphLeft, h - graphBottomPad);
        ctx.lineTo(graphLeft + graphWidth, h - graphBottomPad);
        ctx.stroke();

        this.shadowIndicatorRect = {x: pad, y: pad, size: indicatorSize};
        this.highlightIndicatorRect = {x: w - pad - indicatorSize, y: pad, size: indicatorSize};
        this.drawClippingIndicator(
            this.shadowIndicatorRect.x,
            this.shadowIndicatorRect.y,
            this.shadowIndicatorRect.size,
            this.shadowClipped,
            false,
            this.shadowWarningEnabled
        );
        this.drawClippingIndicator(
            this.highlightIndicatorRect.x,
            this.highlightIndicatorRect.y,
            this.highlightIndicatorRect.size,
            this.highlightClipped,
            true,
            this.highlightWarningEnabled
        );
        this.drawTonalLossStats(graphLeft + indicatorSize * 0.9, pad, graphWidth - indicatorSize * 1.8);
        ctx.restore();
    }
}
