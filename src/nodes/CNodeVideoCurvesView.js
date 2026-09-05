import {registerSurfaceInteraction} from "../SurfaceInteraction";
import {pointerHitRadius} from "../HandleStyle";
import {CNodeViewCanvas2D} from "./CNodeViewCanvas";
import {setRenderOne, UndoManager} from "../Globals";

const CURVE_SIZE = 256;
const HIT_RADIUS = 18;
const CURVE_HIT_RADIUS = 20;

export class CNodeVideoCurvesView extends CNodeViewCanvas2D {
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
        this.points = [
            {x: 0, y: 0},
            {x: 255, y: 1},
        ];
        this.selectedPointIndex = -1;
        this.draggingPointIndex = -1;
        this.curveLUT = new Uint8ClampedArray(CURVE_SIZE);
        this.curveDirty = true;
        this.curveRevision = 0;
        this.graphRect = null;
        this.resetButtonRect = null;

        this.div.style.border = "1px solid rgba(255,255,255,0.22)";
        this.div.style.boxShadow = "0 2px 8px rgba(0,0,0,0.45)";
        this.canvas.style.pointerEvents = "none";
        this.div.tabIndex = 0;
        this.installInteraction();
        this.div.addEventListener("keydown", this.handleKeyDown);
        this.updateCurveLUT();
        if (this.pendingSerializedPoints) {
            this.applySerializedPoints(this.pendingSerializedPoints);
            this.pendingSerializedPoints = null;
        }
    }

    dispose() {
        this.unregisterInteraction?.();
        this.div.removeEventListener("keydown", this.handleKeyDown);
        this.curveLUT = null;
        super.dispose();
    }

    installInteraction() {
        this.unregisterInteraction = registerSurfaceInteraction(this.div, {
            profile: "adjustments",
            model: this, view: this, enabled: () => this.visible && !!this.graphRect,
            hitTest: e => {
                const p = this.eventToLocalPoint(e);
                return this.rectContainsPoint(this.resetButtonRect, p.x, p.y) || this.rectContainsPoint(this.graphRect, p.x, p.y)
                    || this.findPointAt(p.x, p.y, pointerHitRadius(e, HIT_RADIUS)) !== -1 ? {} : null;
            },
            begin: e => this.handlePointerDown(e), move: e => this.handlePointerMove(e),
            end: () => this.handlePointerUp(), snapshot: () => this.points.map(p => ({...p})),
            restore: state => this.restorePoints(state), undo: "Edit video curve",
        });
    }

    modSerialize() {
        return {
            ...super.modSerialize(),
            visible: false,
            points: this.points.map(point => ({
                x: Math.round(point.x * 1000) / 1000,
                y: Math.round(point.y * 1000000) / 1000000,
            })),
        };
    }

    modDeserialize(v) {
        super.modDeserialize(v);
        if (v.points) {
            if (this.curveLUT) {
                this.applySerializedPoints(v.points);
            } else {
                this.pendingSerializedPoints = v.points;
            }
        }
    }

    applySerializedPoints(points) {
        this.points = this.normalizeCurvePoints(points);
        this.selectedPointIndex = -1;
        this.draggingPointIndex = -1;
        this.curveDirty = true;
        this.curveRevision++;
        this.updateCurveLUT();
        this.videoView?.invalidateCurveResult?.();
        setRenderOne(true);
    }

    normalizeCurvePoints(points) {
        const normalized = [];
        for (const point of points) {
            const x = Number(point?.x);
            const y = Number(point?.y);
            if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
            normalized.push({
                x: this.clamp255(x),
                y: this.clamp01(y),
            });
        }

        if (normalized.length === 0) {
            normalized.push({x: 0, y: 0}, {x: 255, y: 1});
        } else if (normalized.length === 1) {
            normalized.push(normalized[0].x < 128 ? {x: 255, y: 1} : {x: 0, y: 0});
        }

        normalized.sort((a, b) => a.x - b.x);
        const deduped = [];
        for (const point of normalized) {
            const previous = deduped[deduped.length - 1];
            if (previous && Math.round(previous.x) === Math.round(point.x)) {
                previous.x = Math.round(point.x);
                previous.y = point.y;
            } else {
                deduped.push({...point});
            }
        }

        return deduped;
    }

    getCurveLUT() {
        if (this.curveDirty) this.updateCurveLUT();
        return this.curveLUT;
    }

    updateCurveLUT() {
        const sorted = this.getSortedPoints();
        for (let i = 0; i < CURVE_SIZE; i++) {
            this.curveLUT[i] = Math.round(this.evaluateCurve(i, sorted) * 255);
        }
        this.curveDirty = false;
    }

    getSortedPoints() {
        return [...this.points].sort((a, b) => a.x - b.x);
    }

    evaluateCurve(x, sorted = this.getSortedPoints()) {
        if (x <= sorted[0].x) return sorted[0].y;
        const last = sorted.length - 1;
        if (x >= sorted[last].x) return sorted[last].y;

        if (sorted.length === 2) {
            const t = (x - sorted[0].x) / Math.max(1, sorted[1].x - sorted[0].x);
            return this.clamp01(sorted[0].y + (sorted[1].y - sorted[0].y) * t);
        }

        const secondDerivatives = this.getNaturalSplineSecondDerivatives(sorted);
        let i = 0;
        while (i < last && sorted[i + 1].x < x) i++;

        const p1 = sorted[i];
        const p2 = sorted[i + 1];
        const h = Math.max(1, p2.x - p1.x);
        const a = (p2.x - x) / h;
        const b = (x - p1.x) / h;
        const y = a * p1.y + b * p2.y +
            ((a * a * a - a) * secondDerivatives[i] + (b * b * b - b) * secondDerivatives[i + 1]) * h * h / 6;
        return this.clamp01(y);
    }

    getNaturalSplineSecondDerivatives(points) {
        const n = points.length;
        const second = new Array(n).fill(0);
        const u = new Array(n - 1).fill(0);

        for (let i = 1; i < n - 1; i++) {
            const h0 = Math.max(1, points[i].x - points[i - 1].x);
            const h1 = Math.max(1, points[i + 1].x - points[i].x);
            const sig = h0 / (h0 + h1);
            const p = sig * second[i - 1] + 2;
            second[i] = (sig - 1) / p;
            const slope1 = (points[i + 1].y - points[i].y) / h1;
            const slope0 = (points[i].y - points[i - 1].y) / h0;
            u[i] = (6 * (slope1 - slope0) / (h0 + h1) - sig * u[i - 1]) / p;
        }

        for (let k = n - 2; k >= 0; k--) {
            second[k] = second[k] * second[k + 1] + u[k];
        }

        return second;
    }

    markCurveChanged() {
        this.curveDirty = true;
        this.curveRevision++;
        this.videoView?.invalidateCurveResult?.();
        setRenderOne(true);
    }

    resetCurve() {
        this.points = [
            {x: 0, y: 0},
            {x: 255, y: 1},
        ];
        this.selectedPointIndex = -1;
        this.draggingPointIndex = -1;
        this.markCurveChanged();
    }

    handlePointerDown = (event) => {
        if (event.button !== 0) return;
        if (!this.visible || !this.graphRect) return;
        const local = this.eventToLocalPoint(event);
        if (this.rectContainsPoint(this.resetButtonRect, local.x, local.y)) {
            this.resetCurve();
            event.preventDefault();
            event.stopPropagation();
            event.stopImmediatePropagation();
            return;
        }
        this.grabOffset = {x: 0, y: 0};
        const pointIndex = this.findPointAt(local.x, local.y, pointerHitRadius(event, HIT_RADIUS));
        if (pointIndex !== -1) {
            this.selectedPointIndex = pointIndex;
            this.draggingPointIndex = pointIndex;
            const point = this.graphToLocal(this.points[pointIndex]);
            this.grabOffset = {x: local.x - point.x, y: local.y - point.y};
        } else if (this.rectContainsPoint(this.graphRect, local.x, local.y) && this.isNearCurve(local.x, local.y)) {
            const graphPoint = this.localToGraph(local.x, local.y);
            const newPoint = {
                x: graphPoint.x,
                y: this.evaluateCurve(graphPoint.x),
            };
            this.points.push(newPoint);
            this.selectedPointIndex = this.points.length - 1;
            this.draggingPointIndex = this.selectedPointIndex;
            this.setPointFromLocal(this.draggingPointIndex, local.x, local.y);
        } else {
            this.selectedPointIndex = -1;
            setRenderOne(true);
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        this.div.focus();
        this.markCurveChanged();
    };

    handlePointerMove = (event) => {
        if (this.draggingPointIndex === -1) return;
        const local = this.eventToLocalPoint(event);
        this.setPointFromLocal(this.draggingPointIndex, local.x - (this.grabOffset?.x ?? 0), local.y - (this.grabOffset?.y ?? 0));
        event.preventDefault();
        event.stopPropagation();
        this.markCurveChanged();
    };

    handlePointerUp = () => {
        this.draggingPointIndex = -1;
    };

    restorePoints(state) {
        this.points = state.map(p => ({...p}));
        this.selectedPointIndex = this.draggingPointIndex = -1;
        this.markCurveChanged();
    }

    handleKeyDown = (event) => {
        if (!this.visible || this.selectedPointIndex === -1) return;
        if (this.draggingPointIndex !== -1 || event.target?.closest?.("input,textarea,[contenteditable=true]")) return;
        if (event.key !== "Delete" && event.key !== "Backspace") return;
        if (this.isEndpointIndex(this.selectedPointIndex)) return;

        const before = this.points.map(p => ({...p}));
        this.points.splice(this.selectedPointIndex, 1);
        this.selectedPointIndex = -1;
        this.draggingPointIndex = -1;
        event.preventDefault();
        this.markCurveChanged();
        const after = this.points.map(p => ({...p}));
        UndoManager.add({description: "Delete curve point", undo: () => this.restorePoints(before), redo: () => this.restorePoints(after)});
    };

    eventToLocalPoint(event) {
        const rect = this.div.getBoundingClientRect();
        return {
            x: event.clientX - rect.left,
            y: event.clientY - rect.top,
        };
    }

    rectContainsPoint(rect, x, y) {
        return !!rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    }

    localToGraph(x, y) {
        const rect = this.graphRect;
        return {
            x: this.clamp255(((x - rect.left) / rect.width) * 255),
            y: this.clamp01(1 - ((y - rect.top) / rect.height)),
        };
    }

    graphToLocal(point) {
        const rect = this.graphRect;
        return {
            x: rect.left + (point.x / 255) * rect.width,
            y: rect.top + (1 - point.y) * rect.height,
        };
    }

    findPointAt(x, y, radius = HIT_RADIUS) {
        for (let i = this.points.length - 1; i >= 0; i--) {
            const local = this.graphToLocal(this.points[i]);
            const dx = local.x - x;
            const dy = local.y - y;
            if (Math.sqrt(dx * dx + dy * dy) <= radius) return i;
        }
        return -1;
    }

    isNearCurve(x, y) {
        const graphPoint = this.localToGraph(x, y);
        const curveY = this.evaluateCurve(graphPoint.x);
        const curveLocal = this.graphToLocal({x: graphPoint.x, y: curveY});
        return Math.abs(curveLocal.y - y) <= CURVE_HIT_RADIUS;
    }

    setPointFromLocal(index, x, y) {
        const graphPoint = this.localToGraph(x, y);
        const point = this.points[index];
        const endpointRole = this.endpointRole(index);
        if (endpointRole === "start") {
            point.x = Math.min(this.neighborX(index, 1) - 1, graphPoint.x);
            point.y = graphPoint.y;
        } else if (endpointRole === "end") {
            point.x = Math.max(this.neighborX(index, -1) + 1, graphPoint.x);
            point.y = graphPoint.y;
        } else {
            const minX = this.neighborX(index, -1) + 1;
            const maxX = this.neighborX(index, 1) - 1;
            point.x = Math.max(minX, Math.min(maxX, graphPoint.x));
            point.y = graphPoint.y;
        }
    }

    neighborX(index, direction) {
        const point = this.points[index];
        let neighbor = direction < 0 ? 0 : 255;
        for (const other of this.points) {
            if (other === point) continue;
            if (direction < 0 && other.x < point.x && other.x > neighbor) neighbor = other.x;
            if (direction > 0 && other.x > point.x && other.x < neighbor) neighbor = other.x;
        }
        return neighbor;
    }

    isEndpointIndex(index) {
        return this.endpointRole(index) !== null;
    }

    endpointRole(index) {
        const point = this.points[index];
        if (!point) return null;
        const sorted = this.getSortedPoints();
        if (point === sorted[0]) return "start";
        if (point === sorted[sorted.length - 1]) return "end";
        return null;
    }

    clamp01(value) {
        return Math.max(0, Math.min(1, value));
    }

    clamp255(value) {
        return Math.max(0, Math.min(255, value));
    }

    drawGrid(rect) {
        const ctx = this.ctx;
        ctx.fillStyle = "rgba(38,38,38,0.94)";
        ctx.fillRect(rect.left, rect.top, rect.width, rect.height);

        ctx.strokeStyle = "rgba(255,255,255,0.12)";
        ctx.lineWidth = 1 / this.devicePixelRatio;
        for (let i = 0; i <= 4; i++) {
            const x = rect.left + rect.width * i / 4;
            const y = rect.top + rect.height * i / 4;
            ctx.beginPath();
            ctx.moveTo(x, rect.top);
            ctx.lineTo(x, rect.bottom);
            ctx.moveTo(rect.left, y);
            ctx.lineTo(rect.right, y);
            ctx.stroke();
        }

        ctx.strokeStyle = "rgba(0,0,0,0.35)";
        ctx.beginPath();
        ctx.moveTo(rect.left, rect.bottom);
        ctx.lineTo(rect.right, rect.top);
        ctx.stroke();

        ctx.strokeStyle = "rgba(255,255,255,0.55)";
        ctx.strokeRect(rect.left, rect.top, rect.width, rect.height);
    }

    drawCurve(rect) {
        const ctx = this.ctx;
        ctx.strokeStyle = "rgba(255,255,255,0.96)";
        ctx.lineWidth = Math.max(2, 2 / this.devicePixelRatio);
        ctx.beginPath();
        for (let x = 0; x < CURVE_SIZE; x++) {
            const y = this.evaluateCurve(x);
            const px = rect.left + (x / 255) * rect.width;
            const py = rect.top + (1 - y) * rect.height;
            if (x === 0) ctx.moveTo(px, py);
            else ctx.lineTo(px, py);
        }
        ctx.stroke();
    }

    drawPoints() {
        const ctx = this.ctx;
        for (let i = 0; i < this.points.length; i++) {
            const local = this.graphToLocal(this.points[i]);
            const selected = i === this.selectedPointIndex;
            ctx.strokeStyle = selected ? "rgba(0,0,0,0.95)" : "rgba(255,255,255,0.92)";
            ctx.lineWidth = 2 / this.devicePixelRatio;
            const size = selected ? 11 : 9;
            if (selected) {
                ctx.fillStyle = "rgba(255,255,255,1)";
                ctx.fillRect(local.x - size / 2, local.y - size / 2, size, size);
            }
            ctx.strokeRect(local.x - size / 2, local.y - size / 2, size, size);
        }
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

        const ctx = this.ctx;
        const w = this.widthPx;
        const h = this.heightPx;
        if (w <= 0 || h <= 0) return;

        ctx.save();
        ctx.clearRect(0, 0, w, h);
        ctx.fillStyle = "rgba(28,28,28,0.92)";
        ctx.fillRect(0, 0, w, h);

        const pad = Math.max(10, Math.round(Math.min(w, h) * 0.045));
        this.resetButtonRect = {
            left: w - pad - 56,
            top: pad,
            right: w - pad,
            bottom: pad + 24,
            width: 56,
            height: 24,
        };
        this.graphRect = {
            left: pad,
            top: pad + 32,
            right: w - pad,
            bottom: h - pad,
            width: Math.max(1, w - pad * 2),
            height: Math.max(1, h - pad * 2 - 32),
        };

        this.drawResetButton();
        this.drawGrid(this.graphRect);
        this.drawCurve(this.graphRect);
        this.drawPoints();
        ctx.restore();
    }
}
