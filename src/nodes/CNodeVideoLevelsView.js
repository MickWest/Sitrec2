import {CNodeViewCanvas2D} from "./CNodeViewCanvas";
import {markSitchDirty, setRenderOne} from "../Globals";

const LEVEL_BINS = 256;
const HANDLE_RADIUS = 18;
const TRACK_HIT_HEIGHT = 26;

export class CNodeVideoLevelsView extends CNodeViewCanvas2D {
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
        this.sampleCanvas.width = LEVEL_BINS;
        this.sampleCanvas.height = LEVEL_BINS;
        this.sampleCtx = this.sampleCanvas.getContext("2d", {willReadFrequently: true});
        this.histogram = new Uint32Array(LEVEL_BINS);
        this.lastFrame = -1;
        this.lastVideoData = null;
        this.draggingHandle = null;
        this.activeHandle = null;
        this.inputRect = null;
        this.outputRect = null;
        this.resetButtonRect = null;
        this.handles = new Map();

        this.div.style.border = "1px solid rgba(255,255,255,0.22)";
        this.div.style.boxShadow = "0 2px 8px rgba(0,0,0,0.45)";
        this.canvas.style.pointerEvents = "none";
        this.div.tabIndex = 0;
        this.div.addEventListener("pointerdown", this.handlePointerDown, true);
        document.addEventListener("pointermove", this.handlePointerMove);
        document.addEventListener("pointerup", this.handlePointerUp);
    }

    dispose() {
        this.div?.removeEventListener("pointerdown", this.handlePointerDown, true);
        document.removeEventListener("pointermove", this.handlePointerMove);
        document.removeEventListener("pointerup", this.handlePointerUp);
        this.sampleCtx = null;
        this.sampleCanvas = null;
        this.histogram = null;
        super.dispose();
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            visible: false,
            levels: this.values(),
        };
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        if (v.levels) {
            this.setNodeValue(this.inputBlackNode, v.levels.inputBlack ?? 0);
            this.setNodeValue(this.midpointNode, v.levels.midpoint ?? 1);
            this.setNodeValue(this.inputWhiteNode, v.levels.inputWhite ?? 255);
            this.setNodeValue(this.outputBlackNode, v.levels.outputBlack ?? 0);
            this.setNodeValue(this.outputWhiteNode, v.levels.outputWhite ?? 255);
            this.videoView?.invalidateLevelsResult?.();
        }
    }

    get inputBlackNode() { return this.videoView?.in?.levelsInputBlack; }
    get inputWhiteNode() { return this.videoView?.in?.levelsInputWhite; }
    get midpointNode() { return this.videoView?.in?.levelsMidpoint; }
    get outputBlackNode() { return this.videoView?.in?.levelsOutputBlack; }
    get outputWhiteNode() { return this.videoView?.in?.levelsOutputWhite; }

    getValue(node, fallback) {
        const value = node?.v0 ?? node?.value;
        return Number.isFinite(value) ? value : fallback;
    }

    setNodeValue(node, value) {
        if (!node) return;
        if (typeof node.setValue === "function") {
            node.setValue(value);
        } else {
            node.value = value;
        }
    }

    values() {
        const inputBlack = this.clamp255(this.getValue(this.inputBlackNode, 0));
        const inputWhite = this.clamp255(this.getValue(this.inputWhiteNode, 255));
        return {
            inputBlack,
            inputWhite: Math.max(inputBlack + 1, inputWhite),
            midpoint: this.clampMidpoint(this.getValue(this.midpointNode, 1)),
            outputBlack: this.clamp255(this.getValue(this.outputBlackNode, 0)),
            outputWhite: this.clamp255(this.getValue(this.outputWhiteNode, 255)),
        };
    }

    setValue(handle, value) {
        const current = this.values();
        if (handle === "inputBlack") {
            this.setNodeValue(this.inputBlackNode, Math.min(this.clamp255(value), current.inputWhite - 1));
        } else if (handle === "inputWhite") {
            this.setNodeValue(this.inputWhiteNode, Math.max(this.clamp255(value), current.inputBlack + 1));
        } else if (handle === "midpoint") {
            this.setNodeValue(this.midpointNode, this.clampMidpoint(value));
        } else if (handle === "outputBlack") {
            this.setNodeValue(this.outputBlackNode, Math.min(this.clamp255(value), current.outputWhite));
        } else if (handle === "outputWhite") {
            this.setNodeValue(this.outputWhiteNode, Math.max(this.clamp255(value), current.outputBlack));
        }
        this.videoView?.invalidateLevelsResult?.();
        markSitchDirty();
        setRenderOne(true);
    }

    resetLevels() {
        this.setNodeValue(this.inputBlackNode, 0);
        this.setNodeValue(this.midpointNode, 1);
        this.setNodeValue(this.inputWhiteNode, 255);
        this.setNodeValue(this.outputBlackNode, 0);
        this.setNodeValue(this.outputWhiteNode, 255);
        this.videoView?.invalidateLevelsResult?.();
        markSitchDirty();
        setRenderOne(true);
    }

    updateHistogram(frame) {
        const videoView = this.videoView;
        if (!videoView?.videoData) return false;
        if (frame === this.lastFrame && videoView.videoData === this.lastVideoData) return true;

        videoView.videoData.update();
        const image = videoView.videoData.getImage(frame);
        if (!image) return false;

        const sourceWidth = image.videoWidth || image.naturalWidth || image.width;
        const sourceHeight = image.videoHeight || image.naturalHeight || image.height;
        if (!sourceWidth || !sourceHeight) return false;

        const scale = Math.min(1, LEVEL_BINS / Math.max(sourceWidth, sourceHeight));
        const sampleWidth = Math.max(1, Math.round(sourceWidth * scale));
        const sampleHeight = Math.max(1, Math.round(sourceHeight * scale));

        if (this.sampleCanvas.width !== sampleWidth || this.sampleCanvas.height !== sampleHeight) {
            this.sampleCanvas.width = sampleWidth;
            this.sampleCanvas.height = sampleHeight;
        }

        this.sampleCtx.clearRect(0, 0, sampleWidth, sampleHeight);
        this.sampleCtx.drawImage(image, 0, 0, sourceWidth, sourceHeight, 0, 0, sampleWidth, sampleHeight);
        const data = this.sampleCtx.getImageData(0, 0, sampleWidth, sampleHeight).data;

        this.histogram.fill(0);
        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] === 0) continue;
            const luminance = Math.round(data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722);
            this.histogram[luminance]++;
        }

        this.lastFrame = frame;
        this.lastVideoData = videoView.videoData;
        return true;
    }

    maxBinValue() {
        let max = 1;
        for (let i = 0; i < LEVEL_BINS; i++) {
            if (this.histogram[i] > max) max = this.histogram[i];
        }
        return max;
    }

    eventToLocalPoint(event) {
        const rect = this.div.getBoundingClientRect();
        return {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
        };
    }

    handlePointerDown = (event) => {
        if (event.button !== 0) return;
        if (!this.visible) return;
        const local = this.eventToLocalPoint(event);
        if (this.rectContainsPoint(this.resetButtonRect, local.x, local.y)) {
            this.resetLevels();
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            return;
        }
        const handle = this.findControlAt(local.x, local.y);
        if (!handle) return;

        this.activeHandle = handle;
        this.draggingHandle = handle;
        this.setValue(handle, this.valueFromLocal(handle, local.x));
        this.div.focus();
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
    };

    handlePointerMove = (event) => {
        if (!this.draggingHandle) return;
        const local = this.eventToLocalPoint(event);
        this.setValue(this.draggingHandle, this.valueFromLocal(this.draggingHandle, local.x));
        event.preventDefault();
        event.stopPropagation();
    };

    handlePointerUp = () => {
        this.draggingHandle = null;
    };

    findHandle(x, y) {
        let best = null;
        let bestDistance = HANDLE_RADIUS + 1;
        for (const [name, point] of this.handles.entries()) {
            const dx = point.x - x;
            const dy = point.y - y;
            const distance = Math.sqrt(dx * dx + dy * dy);
            if (distance < bestDistance) {
                best = name;
                bestDistance = distance;
            }
        }
        return best;
    }

    rectContainsPoint(rect, x, y) {
        return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }

    findControlAt(x, y) {
        const directHandle = this.findHandle(x, y);
        if (directHandle) return directHandle;

        if (this.inputRect) {
            const inputBandTop = this.inputRect.top;
            const inputBandBottom = this.inputRect.bottom + TRACK_HIT_HEIGHT;
            if (x >= this.inputRect.left && x <= this.inputRect.right && y >= inputBandTop && y <= inputBandBottom) {
                return this.nearestHandle(x, ["inputBlack", "midpoint", "inputWhite"]);
            }
        }

        if (this.outputRect) {
            const outputBandTop = this.outputRect.top;
            const outputBandBottom = this.outputRect.bottom + TRACK_HIT_HEIGHT;
            if (x >= this.outputRect.left && x <= this.outputRect.right && y >= outputBandTop && y <= outputBandBottom) {
                return this.nearestHandle(x, ["outputBlack", "outputWhite"]);
            }
        }

        return null;
    }

    nearestHandle(x, candidates) {
        let best = null;
        let bestDistance = Infinity;
        for (const name of candidates) {
            const point = this.handles.get(name);
            if (!point) continue;
            const distance = Math.abs(point.x - x);
            if (distance < bestDistance) {
                best = name;
                bestDistance = distance;
            }
        }
        return best;
    }

    valueFromLocal(handle, x) {
        if (handle === "midpoint") {
            const values = this.values();
            const left = this.inputValueToX(values.inputBlack);
            const right = this.inputValueToX(values.inputWhite);
            const t = this.clamp01((x - left) / Math.max(1, right - left));
            if (t <= 0.0001) return 9.99;
            if (t >= 0.9999) return 0.01;
            return Math.round((Math.log(t) / Math.log(0.5)) * 100) / 100;
        }
        const rect = handle.startsWith("output") ? this.outputRect : this.inputRect;
        const t = this.clamp01((x - rect.left) / rect.width);
        return Math.round(t * 255);
    }

    inputValueToX(value) {
        return this.inputRect.left + (value / 255) * this.inputRect.width;
    }

    outputValueToX(value) {
        return this.outputRect.left + (value / 255) * this.outputRect.width;
    }

    midpointToX(values) {
        const t = Math.pow(0.5, values.midpoint);
        return this.inputValueToX(values.inputBlack) +
            (this.inputValueToX(values.inputWhite) - this.inputValueToX(values.inputBlack)) * t;
    }

    clamp01(value) {
        return Math.max(0, Math.min(1, value));
    }

    clamp255(value) {
        return Math.max(0, Math.min(255, Math.round(value)));
    }

    clampMidpoint(value) {
        return Math.max(0.01, Math.min(9.99, Math.round(value * 100) / 100));
    }

    drawHistogram(rect) {
        const ctx = this.ctx;
        const bottom = rect.bottom;
        const maxValue = this.maxBinValue();
        ctx.beginPath();
        ctx.moveTo(rect.left, bottom);
        for (let i = 0; i < LEVEL_BINS; i++) {
            const x = rect.left + (i / (LEVEL_BINS - 1)) * rect.width;
            const y = bottom - (this.histogram[i] / maxValue) * rect.height;
            ctx.lineTo(x, y);
        }
        ctx.lineTo(rect.right, bottom);
        ctx.closePath();
        ctx.fillStyle = "rgba(225,225,225,0.86)";
        ctx.fill();
    }

    drawHandle(name, x, y, fillStyle) {
        const ctx = this.ctx;
        this.handles.set(name, {x, y});
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x - 7, y + 14);
        ctx.lineTo(x + 7, y + 14);
        ctx.closePath();
        ctx.fillStyle = fillStyle;
        ctx.strokeStyle = name === this.activeHandle ? "rgba(122,184,255,0.95)" : "rgba(0,0,0,0.95)";
        ctx.lineWidth = 1.5 / this.devicePixelRatio;
        ctx.fill();
        ctx.stroke();
    }

    drawNumber(value, x, y, width = 48) {
        const ctx = this.ctx;
        ctx.fillStyle = "rgba(42,42,42,0.96)";
        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.fillRect(x, y, width, 22);
        ctx.strokeRect(x, y, width, 22);
        ctx.fillStyle = "rgba(245,245,245,0.95)";
        ctx.font = "13px Arial";
        ctx.textBaseline = "middle";
        ctx.fillText(String(value), x + 7, y + 11);
    }

    drawOutputGradient(rect) {
        const ctx = this.ctx;
        const gradient = ctx.createLinearGradient(rect.left, 0, rect.right, 0);
        gradient.addColorStop(0, "black");
        gradient.addColorStop(1, "white");
        ctx.fillStyle = gradient;
        ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
        ctx.strokeStyle = "rgba(255,255,255,0.28)";
        ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
    }

    drawResetButton() {
        const ctx = this.ctx;
        const rect = this.resetButtonRect;
        ctx.fillStyle = "rgba(48,48,48,0.98)";
        ctx.strokeStyle = "rgba(255,255,255,0.28)";
        ctx.lineWidth = 1 / this.devicePixelRatio;
        ctx.fillRect(rect.left, rect.top, rect.width, rect.height);
        ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
        ctx.fillStyle = "rgba(245,245,245,0.95)";
        ctx.font = "13px Arial";
        ctx.textBaseline = "middle";
        ctx.textAlign = "center";
        ctx.fillText("Reset", rect.left + rect.width / 2, rect.top + rect.height / 2);
        ctx.textAlign = "start";
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
        ctx.fillStyle = "rgba(38,38,38,0.94)";
        ctx.fillRect(0, 0, w, h);

        const pad = Math.max(12, Math.round(Math.min(w, h) * 0.055));
        ctx.fillStyle = "rgba(244,244,244,0.94)";
        ctx.font = "bold 16px Arial";
        ctx.textBaseline = "top";
        ctx.fillText("Levels", pad, pad);
        this.resetButtonRect = {
            left: w - pad - 56,
            top: pad,
            right: w - pad,
            bottom: pad + 24,
            width: 56,
            height: 24,
        };
        this.drawResetButton();

        ctx.font = "13px Arial";
        ctx.fillStyle = "rgba(225,225,225,0.94)";
        ctx.fillText("Input Levels", pad, pad + 28);

        const graphTop = pad + 50;
        const graphHeight = Math.max(72, h * 0.38);
        this.inputRect = {
            left: pad,
            top: graphTop,
            right: w - pad,
            bottom: graphTop + graphHeight,
            width: w - pad * 2,
            height: graphHeight,
        };

        ctx.fillStyle = "rgba(22,22,22,0.86)";
        ctx.fillRect(this.inputRect.left, this.inputRect.top, this.inputRect.width, this.inputRect.height);
        this.drawHistogram(this.inputRect);
        ctx.strokeStyle = "rgba(255,255,255,0.22)";
        ctx.strokeRect(this.inputRect.left, this.inputRect.top, this.inputRect.width, this.inputRect.height);

        const values = this.values();
        this.handles.clear();
        const inputY = this.inputRect.bottom + 2;
        this.drawHandle("inputBlack", this.inputValueToX(values.inputBlack), inputY, "rgba(20,20,20,1)");
        this.drawHandle("midpoint", this.midpointToX(values), inputY, "rgba(150,150,150,1)");
        this.drawHandle("inputWhite", this.inputValueToX(values.inputWhite), inputY, "rgba(245,245,245,1)");

        const numberY = inputY + 25;
        this.drawNumber(values.inputBlack, this.inputRect.left, numberY);
        this.drawNumber(values.midpoint, this.inputRect.left + this.inputRect.width / 2 - 24, numberY);
        this.drawNumber(values.inputWhite, this.inputRect.right - 48, numberY);

        ctx.strokeStyle = "rgba(255,255,255,0.18)";
        ctx.beginPath();
        ctx.moveTo(pad, numberY + 38);
        ctx.lineTo(w - pad, numberY + 38);
        ctx.stroke();

        ctx.fillStyle = "rgba(225,225,225,0.94)";
        ctx.fillText("Output Levels", pad, numberY + 50);

        this.outputRect = {
            left: pad,
            top: numberY + 78,
            right: w - pad,
            bottom: numberY + 100,
            width: w - pad * 2,
            height: 22,
        };
        this.drawOutputGradient(this.outputRect);

        const outputY = this.outputRect.bottom + 2;
        this.drawHandle("outputBlack", this.outputValueToX(values.outputBlack), outputY, "rgba(20,20,20,1)");
        this.drawHandle("outputWhite", this.outputValueToX(values.outputWhite), outputY, "rgba(245,245,245,1)");
        this.drawNumber(values.outputBlack, this.outputRect.left, outputY + 25);
        this.drawNumber(values.outputWhite, this.outputRect.right - 48, outputY + 25);

        ctx.restore();
    }
}
