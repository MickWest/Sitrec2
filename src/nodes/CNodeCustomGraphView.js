// CNodeCustomGraphView
//
// The on-screen graph window for a user-created "Custom Graph". It is a thin
// subclass of the existing OSD graph view (CNodeOSDGraphView) that adds:
//   - a third Y axis (Y3) drawn on the outer right (Y1 alone on the left,
//     Y2 inner-right, Y3 outer-right)
//   - a dark/light colour theme (dark default)
//   - a legend that can be toggled off
//   - an on-canvas title
//   - per-series FIXED ranges (a descriptor may pin its axis range)
//   - a per-instance rebuildCallback (instead of the OSD graph's hardcoded
//     reference to the OSD data-series controller)
//
// The OSD graph itself is left completely untouched. Only the margin helpers,
// autoScale, a couple of crosshair helpers, and renderCanvas are overridden.

import {CNodeOSDGraphView} from "./CNodeCurveEdit2";
import {CNodeTabbedCanvasView} from "./CNodeTabbedCanvasView";
import {NodeMan, setRenderOne, Sit} from "../Globals";
import {par} from "../par";

// Per-axis series colours. Index 0 = Y1, 1 = Y2, 2 = Y3.
const AXIS_COLORS_DARK  = ['#4af', '#f44', '#4f4'];
const AXIS_COLORS_LIGHT = ['#06c', '#c00', '#080'];

const DARK_THEME  = { bg: '#000', frame: '#444', grid: '#333', text: '#ddd', title: '#fff', crosshair: '#ff0', axis: AXIS_COLORS_DARK };
const LIGHT_THEME = { bg: '#fff', frame: '#aaa', grid: '#ddd', text: '#333', title: '#000', crosshair: '#c80', axis: AXIS_COLORS_LIGHT };

export class CNodeCustomGraphView extends CNodeOSDGraphView {
    constructor(v) {
        // No auto "Views" checkbox; the per-graph subfolder "Show" toggle is the
        // single visibility control (CNodeView gates the auto checkbox on this).
        v.excludeFromViewsMenu = true;
        super(v);
        this.hasY3 = false;
        this.minY3 = 0;
        this.maxY3 = 1;
        this.dark = v.dark ?? true;
        this.showLegend = v.showLegend ?? true;
        this.title = v.title ?? "";
        // Set by CCustomGraphManager; called once per render so the graph can
        // pull fresh data / refresh selectors. Null until wired.
        this.rebuildCallback = null;
        // Centred message shown when there is nothing to plot (set by the
        // manager: "select a series" vs "selected series have no data yet").
        this.emptyMessage = null;
        // {min, max} to pin the frame-X axis to (rolling-window mode), or
        // null to autoscale the axis to the plotted data. Set by the manager.
        this.fixedXRange = null;
        // Sized-scatter mode (setScatterData): the graph plots free-standing
        // {x, y, size} points instead of per-frame series — no frame coupling,
        // no equal-aspect forcing, dot AREA carries the third column.
        this.scatterMode = false;
        this.scatter = null;
        this._hoverIndex = -1;
    }

    /**
     * Switch the view to sized-scatter mode and set its data.
     *
     * @param d.points     [{x, y, size, label, color}] — size and color optional
     * @param d.xLabel     x-axis title
     * @param d.yLabel     y-axis title (drawn rotated on the left)
     * @param d.sizeLabel  what dot size encodes, shown in the corner (optional)
     */
    setScatterData(d) {
        this.scatterMode = true;
        this.isFrameX = false;
        // Leaving the canvas ends the hover — without this the last dot's
        // highlight (and any host row highlight) sticks forever.
        if (this.canvas && !this._scatterLeaveWired) {
            this._scatterLeaveWired = true;
            this.canvas.addEventListener("mouseleave", () => {
                if (this._hoverIndex !== -1) {
                    this._hoverIndex = -1;
                    this.onScatterHover?.(null);
                    setRenderOne();
                }
            });
        }
        // Inherited frame/crosshair machinery all no-ops on an empty series
        // list, which is what keeps the OSD base class untouched here.
        this.series = [];
        this.scatter = {
            points: d.points ?? [],
            xLabel: d.xLabel ?? "",
            yLabel: d.yLabel ?? "",
            sizeLabel: d.sizeLabel ?? null,
        };
        this._hoverIndex = -1;
        this.scatterAutoScale();
        setRenderOne();
    }

    // Plain independent min/max autoscale for scatter data. The value-X branch
    // of autoScale() forces equal aspect (square units), which is right for
    // spatial pairs and wrong for arbitrary column pairs like duration vs
    // relative separation.
    scatterAutoScale() {
        const pts = this.scatter?.points ?? [];
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const p of pts) {
            if (p.x < minX) minX = p.x;
            if (p.x > maxX) maxX = p.x;
            if (p.y < minY) minY = p.y;
            if (p.y > maxY) maxY = p.y;
        }
        if (!isFinite(minX)) { minX = 0; maxX = 1; }
        if (!isFinite(minY)) { minY = 0; maxY = 1; }
        if (minX === maxX) { minX -= 1; maxX += 1; }
        if (minY === maxY) { minY -= 1; maxY += 1; }
        const px = (maxX - minX) * 0.06, py = (maxY - minY) * 0.06;
        this.minX = minX - px; this.maxX = maxX + px;
        this.minY = minY - py; this.maxY = maxY + py;
        this.hasY2 = false;
        this.hasY3 = false;
    }

    // Single source of truth for the right margin. 60px base, +40 per right axis.
    _rightMargin() {
        return 60 + (this.hasY2 ? 40 : 0) + (this.hasY3 ? 40 : 0);
    }

    // [minY, maxY, axisColorIndex] for a series, by its yAxis (1/2/3).
    axisBounds(s) {
        if (s.yAxis === 3) return [this.minY3, this.maxY3, 2];
        if (s.yAxis === 2) return [this.minY2, this.maxY2, 1];
        return [this.minY, this.maxY, 0];
    }

    // --- coordinate helpers: identical to the base but use _rightMargin() ---

    screenToGraphAxis(screenX, screenY, minY, maxY) {
        const rect = this.canvas.getBoundingClientRect();
        const x = screenX - rect.left;
        const y = screenY - rect.top;
        const margin = 60;
        const graphWidth = this.widthPx - margin - this._rightMargin();
        const graphHeight = this.heightPx - margin * 2;
        const graphX = this.minX + (x - margin) / graphWidth * (this.maxX - this.minX);
        const graphY = maxY - (y - margin) / graphHeight * (maxY - minY);
        return { x: graphX, y: graphY };
    }

    graphToScreenAxis(graphX, graphY, minY, maxY) {
        const margin = 60;
        const graphWidth = this.widthPx - margin - this._rightMargin();
        const graphHeight = this.heightPx - margin * 2;
        const x = margin + (graphX - this.minX) / (this.maxX - this.minX) * graphWidth;
        const y = margin + (maxY - graphY) / (maxY - minY) * graphHeight;
        return { x, y };
    }

    // Crosshair helpers (value-X drag mode) need 3-axis awareness.
    getCrosshairScreenPos() {
        if (this.series.length === 0) return null;
        const currentFrame = Math.floor(par.frame);
        const s = this.series[0];
        const interp = this.interpolateSeriesAtFrame(s, currentFrame);
        if (!interp) return null;
        const interpX = this.isFrameX ? currentFrame : interp.x;
        const [sMinY, sMaxY] = this.axisBounds(s);
        return this.graphToScreenAxis(interpX, interp.y, sMinY, sMaxY);
    }

    snapToNearestByAxis(screenX, screenY, axis) {
        const s = this.series[0];
        if (!s || s.data.length === 0) return;
        const [sMinY, sMaxY] = this.axisBounds(s);
        const sorted = [...s.data].sort((a, b) => a.frame - b.frame);
        const minFrame = sorted[0].frame;
        const maxFrame = sorted[sorted.length - 1].frame;
        let bestDist = Infinity, bestFrame = null;
        for (let f = minFrame; f <= maxFrame; f++) {
            const pt = this.interpolateAtFrame(sorted, f);
            if (!pt) continue;
            const screen = this.graphToScreenAxis(pt.x, pt.y, sMinY, sMaxY);
            const dist = axis === 'h' ? Math.abs(screen.y - screenY) : Math.abs(screen.x - screenX);
            if (dist < bestDist) { bestDist = dist; bestFrame = f; }
        }
        if (bestFrame !== null) {
            const frameSlider = NodeMan.get("frameSlider", false);
            if (frameSlider) frameSlider.setFrame(bestFrame);
            else par.frame = bestFrame;
            setRenderOne();
        }
    }

    // --- frame scrubbing (frame-X mode) -----------------------------------
    // Click/drag anywhere inside the plot to move the current frame — i.e. grab
    // the frame indicator line and drag it. Margin clicks fall through to the
    // base (window drag); value-X keeps the base crosshair behaviour.

    _insidePlot(mx, my) {
        const margin = 60;
        return mx >= margin && mx <= this.widthPx - this._rightMargin()
            && my >= margin && my <= this.heightPx - margin;
    }

    _scrubToEvent(e) {
        const g = this.screenToGraphAxis(e.clientX, e.clientY, this.minY, this.maxY);
        let frame = Math.round(Math.max(this.minX, Math.min(this.maxX, g.x)));
        frame = Math.max(0, Math.min(Sit.frames - 1, frame));
        const fs = NodeMan.get("frameSlider", false) || NodeMan.get("FrameSlider", false);
        if (fs && fs.setFrame) fs.setFrame(frame); else par.frame = frame;
        setRenderOne();
    }

    onMouseDown(e) {
        if (this.isFrameX) {
            const rect = this.canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left, my = e.clientY - rect.top;
            if (this._insidePlot(mx, my)) {
                this._scrubbing = true;
                this.canvas.style.cursor = 'ew-resize';
                this._scrubToEvent(e);
                e.stopPropagation(); e.preventDefault();
                return;
            }
        }
        super.onMouseDown(e);
    }

    onMouseMove(e) {
        if (this._scrubbing) {
            this._scrubToEvent(e);
            e.stopPropagation(); e.preventDefault();
            return;
        }
        if (this.scatterMode) {
            // Hover hit-test: nearest dot within its radius (+4px slack).
            const rect = this.canvas.getBoundingClientRect();
            const mx = e.clientX - rect.left, my = e.clientY - rect.top;
            let best = -1, bestDist = Infinity;
            const pts = this.scatter?.points ?? [];
            for (let i = 0; i < pts.length; i++) {
                const s = this.graphToScreenAxis(pts[i].x, pts[i].y, this.minY, this.maxY);
                const d = Math.hypot(s.x - mx, s.y - my);
                if (d <= (pts[i]._r ?? 5) + 4 && d < bestDist) { bestDist = d; best = i; }
            }
            if (best !== this._hoverIndex) {
                this._hoverIndex = best;
                // Hosts can mirror the hover elsewhere (e.g. highlight the
                // matching table row). null = no dot under the pointer.
                this.onScatterHover?.(best >= 0 ? best : null);
                setRenderOne();
            }
            return;
        }
        super.onMouseMove(e);
    }

    // Radius mapping: dot AREA tracks the size column (sqrt), 3..14 px.
    _scatterRadii() {
        const pts = this.scatter.points;
        const sizes = pts.map((p) => p.size).filter(Number.isFinite);
        const sMin = Math.min(...sizes), sMax = Math.max(...sizes);
        const span = sMax - sMin;
        for (const p of pts) {
            p._r = Number.isFinite(p.size) && span > 0
                ? 3 + 11 * Math.sqrt((p.size - sMin) / span)
                : (Number.isFinite(p.size) ? 8 : 4);
        }
        return {sMin, sMax, sized: sizes.length > 0};
    }

    renderScatter(frame) {
        // A host (e.g. the BotBench modal) may need the graph ABOVE its own
        // overlay. The view manager re-stacks view z-indices, so a one-shot
        // assignment gets overwritten — re-assert it each render instead.
        if (this.scatterElevateZ && this.div
            && this.div.style.zIndex !== String(this.scatterElevateZ)) {
            this.div.style.zIndex = String(this.scatterElevateZ);
        }
        if (this.rebuildCallback) this.rebuildCallback();
        if (this._lastWidth !== this.widthPx || this._lastHeight !== this.heightPx) {
            this._lastWidth = this.widthPx;
            this._lastHeight = this.heightPx;
            this.scatterAutoScale();
        }

        const ctx = this.ctx;
        const c = this.dark ? DARK_THEME : LIGHT_THEME;
        const margin = 60;
        const rightMargin = this._rightMargin();

        CNodeTabbedCanvasView.prototype.renderCanvas.call(this, frame);

        const width = this.widthPx;
        const height = this.heightPx;
        if (width < margin + rightMargin + 10 || height < margin * 2 + 10) return;
        const graphWidth = width - margin - rightMargin;
        const graphHeight = height - margin * 2;

        ctx.fillStyle = c.bg;
        ctx.fillRect(0, 0, width, height);

        if (this.title) {
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillStyle = c.title;
            ctx.fillText(this.title, width / 2, 18);
        }

        ctx.strokeStyle = c.frame;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.rect(margin, margin, graphWidth, graphHeight);
        ctx.stroke();

        const pts = this.scatter?.points ?? [];
        if (pts.length === 0) {
            ctx.fillStyle = c.text;
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(this.emptyMessage ?? "No rows have numbers for both selected columns",
                margin + graphWidth / 2, margin + graphHeight / 2);
            ctx.textAlign = 'left';
            return;
        }

        // Grid + labels. formatLabel on BOTH axes — arbitrary columns can span
        // 0..1, so the frame-graph's integer x labels would collapse to 0/1.
        const xStep = this.calculateStep(this.maxX - this.minX, graphWidth);
        const yStep = this.calculateStep(this.maxY - this.minY, graphHeight);
        const formatLabel = (v) => Math.abs(v) < 1 ? v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")
            : Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v).toString();
        ctx.font = '12px sans-serif';
        ctx.strokeStyle = c.grid;
        for (let x = Math.ceil(this.minX / xStep) * xStep; x <= this.maxX; x += xStep) {
            const s = this.graphToScreenAxis(x, this.minY, this.minY, this.maxY);
            ctx.beginPath(); ctx.moveTo(s.x, margin); ctx.lineTo(s.x, margin + graphHeight); ctx.stroke();
        }
        for (let y = Math.ceil(this.minY / yStep) * yStep; y <= this.maxY; y += yStep) {
            const s = this.graphToScreenAxis(this.minX, y, this.minY, this.maxY);
            ctx.beginPath(); ctx.moveTo(margin, s.y); ctx.lineTo(margin + graphWidth, s.y); ctx.stroke();
        }
        ctx.fillStyle = c.text;
        ctx.textAlign = 'center';
        for (let x = Math.ceil(this.minX / xStep) * xStep; x <= this.maxX; x += xStep) {
            const s = this.graphToScreenAxis(x, this.minY, this.minY, this.maxY);
            ctx.fillText(formatLabel(x), s.x, margin + graphHeight + 20);
        }
        ctx.textAlign = 'right';
        for (let y = Math.ceil(this.minY / yStep) * yStep; y <= this.maxY; y += yStep) {
            const s = this.graphToScreenAxis(this.minX, y, this.minY, this.maxY);
            ctx.fillText(formatLabel(y), margin - 5, s.y + 4);
        }

        // Axis titles: x below, y rotated on the left.
        ctx.font = '14px sans-serif';
        ctx.fillStyle = c.title;
        ctx.textAlign = 'center';
        ctx.fillText(this.scatter.xLabel, margin + graphWidth / 2, height - 10);
        ctx.save();
        ctx.translate(14, margin + graphHeight / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(this.scatter.yLabel, 0, 0);
        ctx.restore();

        // Size legend (top-left corner, inside the margin band).
        const {sMin, sMax, sized} = this._scatterRadii();
        if (sized && this.scatter.sizeLabel) {
            ctx.font = '12px sans-serif';
            ctx.textAlign = 'left';
            ctx.fillStyle = c.text;
            ctx.fillText(`dot size: ${this.scatter.sizeLabel} (${formatLabel(sMin)} – ${formatLabel(sMax)})`,
                5, margin - 8);
        }

        // Dots, smallest-last so big dots never bury small ones, with a
        // background ring so overlapping dots stay separable.
        const order = pts.map((p, i) => i).sort((a, b) => (pts[b]._r ?? 4) - (pts[a]._r ?? 4));
        for (const i of order) {
            const p = pts[i];
            const s = this.graphToScreenAxis(p.x, p.y, this.minY, this.maxY);
            ctx.beginPath();
            ctx.arc(s.x, s.y, p._r, 0, Math.PI * 2);
            ctx.fillStyle = p.color ?? c.axis[0];
            ctx.globalAlpha = 0.8;
            ctx.fill();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = c.bg;
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }

        // Hover label: the point's own label plus its coordinates.
        const h = this._hoverIndex >= 0 ? pts[this._hoverIndex] : null;
        if (h) {
            const s = this.graphToScreenAxis(h.x, h.y, this.minY, this.maxY);
            const lines = [h.label ?? "", `${this.scatter.xLabel}: ${formatLabel(h.x)}   `
                + `${this.scatter.yLabel}: ${formatLabel(h.y)}`
                + (Number.isFinite(h.size) && this.scatter.sizeLabel
                    ? `   ${this.scatter.sizeLabel}: ${formatLabel(h.size)}` : "")]
                .filter((l) => l.length);
            ctx.font = '12px sans-serif';
            const tw = Math.max(...lines.map((l) => ctx.measureText(l).width));
            const bx = Math.min(Math.max(margin, s.x + 12), width - rightMargin - tw - 12);
            const by = Math.max(margin + 6, s.y - 14 - lines.length * 15);
            ctx.fillStyle = this.dark ? 'rgba(0,0,0,0.85)' : 'rgba(255,255,255,0.92)';
            ctx.fillRect(bx - 5, by - 13, tw + 10, lines.length * 15 + 8);
            ctx.strokeStyle = c.frame;
            ctx.strokeRect(bx - 5, by - 13, tw + 10, lines.length * 15 + 8);
            ctx.fillStyle = c.title;
            ctx.textAlign = 'left';
            lines.forEach((l, i) => ctx.fillText(l, bx, by + i * 15));
        }
        ctx.textAlign = 'left';
    }

    onMouseUp(e) {
        if (this._scrubbing) {
            this._scrubbing = false;
            this.canvas.style.cursor = 'default';
            e.stopPropagation(); e.preventDefault();
            return;
        }
        super.onMouseUp(e);
    }

    autoScale() {
        if (this.scatterMode) { this.scatterAutoScale(); return; }
        if (this.series.length === 0) return;

        let allMinX = Infinity, allMaxX = -Infinity;
        const yB = { 1: { min: Infinity, max: -Infinity }, 2: { min: Infinity, max: -Infinity }, 3: { min: Infinity, max: -Infinity } };
        const fixed = { 1: null, 2: null, 3: null };

        for (const s of this.series) {
            const axis = s.yAxis || 1;
            if (Number.isFinite(s.fixedMin) && Number.isFinite(s.fixedMax)) {
                fixed[axis] = { min: s.fixedMin, max: s.fixedMax };
            }
            for (const pt of s.data) {
                if (pt.x < allMinX) allMinX = pt.x;
                if (pt.x > allMaxX) allMaxX = pt.x;
                if (pt.y < yB[axis].min) yB[axis].min = pt.y;
                if (pt.y > yB[axis].max) yB[axis].max = pt.y;
            }
        }

        if (!isFinite(allMinX)) { allMinX = 0; allMaxX = Sit.frames - 1; }
        if (allMinX === allMaxX) { allMinX -= 1; allMaxX += 1; }

        const pad = (b) => {
            if (!isFinite(b.min)) { b.min = 0; b.max = 1; }
            if (b.min === b.max) { b.min -= 1; b.max += 1; }
            const p = (b.max - b.min) * 0.05;
            return { min: b.min - p, max: b.max + p };
        };
        const resolve = (axis, has) => fixed[axis] ? fixed[axis] : (has ? pad(yB[axis]) : { min: 0, max: 1 });

        const hasY1 = this.series.some(s => (s.yAxis || 1) === 1);
        this.hasY2 = this.series.some(s => s.yAxis === 2);   // set BEFORE _rightMargin() use
        this.hasY3 = this.series.some(s => s.yAxis === 3);

        const y1 = resolve(1, hasY1), y2 = resolve(2, this.hasY2), y3 = resolve(3, this.hasY3);

        if (!this.isFrameX) {
            // value-X scatter: keep equal aspect (square units), like the OSD graph
            const margin = 60;
            const graphWidth = this.widthPx - margin - this._rightMargin();
            const graphHeight = this.heightPx - margin * 2;
            const xPad = (allMaxX - allMinX) * 0.02;
            const yPad = (y1.max - y1.min) * 0.02;
            let xRange = (allMaxX - allMinX) + xPad * 2;
            let yRange = (y1.max - y1.min) + yPad * 2;
            const upp = Math.max(xRange / graphWidth, yRange / graphHeight);
            xRange = upp * graphWidth; yRange = upp * graphHeight;
            const xMid = (allMinX + allMaxX) / 2, yMid = (y1.min + y1.max) / 2;
            this.minX = xMid - xRange / 2; this.maxX = xMid + xRange / 2;
            this.minY = yMid - yRange / 2; this.maxY = yMid + yRange / 2;
        } else if (this.fixedXRange
            && Number.isFinite(this.fixedXRange.min) && Number.isFinite(this.fixedXRange.max)) {
            // Rolling-window mode: the controller pins the axis to a constant
            // span (the trace fills toward the right edge, then scrolls).
            // Autoscaling to the sampled data here would visibly stretch the
            // axis while the window fills.
            this.minX = this.fixedXRange.min; this.maxX = this.fixedXRange.max;
            this.minY = y1.min; this.maxY = y1.max;
        } else {
            const xPad = (allMaxX - allMinX) * 0.02;
            this.minX = allMinX - xPad; this.maxX = allMaxX + xPad;
            this.minY = y1.min; this.maxY = y1.max;
        }

        this.minY2 = y2.min; this.maxY2 = y2.max;
        this.minY3 = y3.min; this.maxY3 = y3.max;
    }

    renderCanvas(frame) {
        if (!this.visible) return;
        if (this.scatterMode) { this.renderScatter(frame); return; }

        // Pull fresh data / refresh selectors (throttled inside the callback).
        if (this.rebuildCallback) this.rebuildCallback();

        if (this._lastWidth !== this.widthPx || this._lastHeight !== this.heightPx) {
            this._lastWidth = this.widthPx;
            this._lastHeight = this.heightPx;
            this.autoScale();
        }

        const ctx = this.ctx;
        const c = this.dark ? DARK_THEME : LIGHT_THEME;
        const margin = 60;
        const rightMargin = this._rightMargin();

        // Base canvas setup (sizing/clear). NOT super.renderCanvas — that is the
        // OSD graph's own drawing; we want the grandparent's plain canvas prep.
        CNodeTabbedCanvasView.prototype.renderCanvas.call(this, frame);

        const width = this.widthPx;
        const height = this.heightPx;
        if (width < margin + rightMargin + 10 || height < margin * 2 + 10) return;
        const graphWidth = width - margin - rightMargin;
        const graphHeight = height - margin * 2;

        // background
        ctx.fillStyle = c.bg;
        ctx.fillRect(0, 0, width, height);

        // title (top centre)
        if (this.title) {
            ctx.font = '14px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillStyle = c.title;
            ctx.fillText(this.title, width / 2, 18);
        }

        // frame border
        ctx.strokeStyle = c.frame;
        ctx.lineWidth = 1;
        ctx.font = '12px sans-serif';
        ctx.beginPath();
        ctx.rect(margin, margin, graphWidth, graphHeight);
        ctx.stroke();

        // Nothing to plot: explain why rather than showing a blank frame.
        if (this.series.length === 0 && this.emptyMessage) {
            ctx.fillStyle = c.text;
            ctx.font = '13px sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(this.emptyMessage, margin + graphWidth / 2, margin + graphHeight / 2);
            ctx.textAlign = 'left';
            return;
        }

        const xStep = this.calculateStep(this.maxX - this.minX, graphWidth);
        const y1Step = this.calculateStep(this.maxY - this.minY, graphHeight);
        const formatLabel = (v) => Math.abs(v) < 1 ? v.toFixed(2) : Math.abs(v) < 10 ? v.toFixed(1) : Math.round(v).toString();

        // grid
        ctx.strokeStyle = c.grid;
        ctx.lineWidth = 1;
        for (let x = Math.ceil(this.minX / xStep) * xStep; x <= this.maxX; x += xStep) {
            const screen = this.graphToScreenAxis(x, this.minY, this.minY, this.maxY);
            ctx.beginPath(); ctx.moveTo(screen.x, margin); ctx.lineTo(screen.x, margin + graphHeight); ctx.stroke();
        }
        for (let y = Math.ceil(this.minY / y1Step) * y1Step; y <= this.maxY; y += y1Step) {
            const screen = this.graphToScreenAxis(this.minX, y, this.minY, this.maxY);
            ctx.beginPath(); ctx.moveTo(margin, screen.y); ctx.lineTo(margin + graphWidth, screen.y); ctx.stroke();
        }

        // x axis numeric labels
        ctx.fillStyle = c.text;
        ctx.textAlign = 'center';
        for (let x = Math.ceil(this.minX / xStep) * xStep; x <= this.maxX; x += xStep) {
            const screen = this.graphToScreenAxis(x, this.minY, this.minY, this.maxY);
            ctx.fillText(Math.round(x).toString(), screen.x, margin + graphHeight + 20);
        }

        // Y1 labels (left), coloured per axis
        ctx.fillStyle = c.axis[0];
        ctx.textAlign = 'right';
        for (let y = Math.ceil(this.minY / y1Step) * y1Step; y <= this.maxY; y += y1Step) {
            const screen = this.graphToScreenAxis(this.minX, y, this.minY, this.maxY);
            ctx.fillText(formatLabel(y), margin - 5, screen.y + 4);
        }

        // Y2 labels (inner right)
        if (this.hasY2) {
            const step = this.calculateStep(this.maxY2 - this.minY2, graphHeight);
            ctx.fillStyle = c.axis[1];
            ctx.textAlign = 'left';
            for (let y = Math.ceil(this.minY2 / step) * step; y <= this.maxY2; y += step) {
                const screen = this.graphToScreenAxis(this.maxX, y, this.minY2, this.maxY2);
                ctx.fillText(formatLabel(y), margin + graphWidth + 5, screen.y + 4);
            }
        }

        // Y3 labels (outer right, one column further out than Y2)
        if (this.hasY3) {
            const step = this.calculateStep(this.maxY3 - this.minY3, graphHeight);
            ctx.fillStyle = c.axis[2];
            ctx.textAlign = 'left';
            const xCol = margin + graphWidth + (this.hasY2 ? 45 : 5);
            for (let y = Math.ceil(this.minY3 / step) * step; y <= this.maxY3; y += step) {
                const screen = this.graphToScreenAxis(this.maxX, y, this.minY3, this.maxY3);
                ctx.fillText(formatLabel(y), xCol, screen.y + 4);
            }
        }

        // x axis title
        ctx.font = '14px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillStyle = c.title;
        ctx.fillText(this.xLabel, margin + graphWidth / 2, height - 10);

        // legend (optional)
        if (this.showLegend) {
            const labels = { 1: [], 2: [], 3: [] };
            for (const s of this.series) {
                if (s.raw) continue;
                labels[s.yAxis || 1].push(s.label);
            }
            ctx.font = '12px sans-serif';
            if (labels[1].length) {
                ctx.fillStyle = c.axis[0]; ctx.textAlign = 'left';
                ctx.fillText(labels[1].join(', '), 5, margin - 8);
            }
            if (labels[2].length) {
                ctx.fillStyle = c.axis[1]; ctx.textAlign = 'right';
                ctx.fillText(labels[2].join(', '), width - 5, margin - 8);
            }
            if (labels[3].length) {
                ctx.fillStyle = c.axis[2]; ctx.textAlign = 'right';
                ctx.fillText(labels[3].join(', '), width - 5, margin - 22);
            }
            ctx.textAlign = 'left';
        }

        // series
        for (const s of this.series) {
            if (s.data.length === 0) continue;
            const [sMinY, sMaxY, ci] = this.axisBounds(s);
            const col = c.axis[ci];
            if (this.isFrameX) {
                ctx.strokeStyle = col;
                ctx.lineWidth = 2;
                ctx.setLineDash([]);
                ctx.beginPath();
                let started = false;
                for (const pt of s.data) {
                    const screen = this.graphToScreenAxis(pt.x, pt.y, sMinY, sMaxY);
                    if (!started) { ctx.moveTo(screen.x, screen.y); started = true; }
                    else ctx.lineTo(screen.x, screen.y);
                }
                ctx.stroke();
            } else {
                ctx.strokeStyle = col; ctx.fillStyle = col; ctx.lineWidth = 1;
                ctx.beginPath();
                let prev = null;
                for (const pt of s.data) {
                    const screen = this.graphToScreenAxis(pt.x, pt.y, sMinY, sMaxY);
                    if (prev) { ctx.moveTo(prev.x, prev.y); ctx.lineTo(screen.x, screen.y); }
                    prev = screen;
                }
                ctx.stroke();
                for (const pt of s.data) {
                    const screen = this.graphToScreenAxis(pt.x, pt.y, sMinY, sMaxY);
                    ctx.beginPath(); ctx.arc(screen.x, screen.y, 3, 0, Math.PI * 2); ctx.fill();
                }
            }
        }

        // current-frame crosshair
        const currentFrame = Math.floor(par.frame);
        if (this.isFrameX) {
            if (currentFrame >= this.minX && currentFrame <= this.maxX) {
                const frameScreen = this.graphToScreenAxis(currentFrame, this.minY, this.minY, this.maxY);
                ctx.strokeStyle = c.crosshair; ctx.lineWidth = 2;
                ctx.beginPath(); ctx.moveTo(frameScreen.x, margin); ctx.lineTo(frameScreen.x, height - margin); ctx.stroke();
                for (const s of this.series) {
                    if (s.raw) continue;
                    const interp = this.interpolateSeriesAtFrame(s, currentFrame);
                    if (!interp) continue;
                    const [sMinY, sMaxY, ci] = this.axisBounds(s);
                    const yScreen = this.graphToScreenAxis(currentFrame, interp.y, sMinY, sMaxY);
                    ctx.strokeStyle = c.crosshair; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
                    ctx.beginPath(); ctx.moveTo(margin, yScreen.y); ctx.lineTo(margin + graphWidth, yScreen.y); ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.fillStyle = c.axis[ci];
                    ctx.beginPath(); ctx.arc(frameScreen.x, yScreen.y, 5, 0, Math.PI * 2); ctx.fill();
                }
            }
        } else {
            for (const s of this.series) {
                if (s.raw) continue;
                const interp = this.interpolateSeriesAtFrame(s, currentFrame);
                if (!interp) continue;
                const [sMinY, sMaxY] = this.axisBounds(s);
                const screen = this.graphToScreenAxis(interp.x, interp.y, sMinY, sMaxY);
                ctx.strokeStyle = c.crosshair; ctx.lineWidth = 1;
                ctx.beginPath(); ctx.moveTo(screen.x, margin); ctx.lineTo(screen.x, margin + graphHeight); ctx.stroke();
                ctx.beginPath(); ctx.moveTo(margin, screen.y); ctx.lineTo(margin + graphWidth, screen.y); ctx.stroke();
                break;
            }
        }
    }
}
