import {CNodeCurveEditorView2} from "./nodes/CNodeCurveEdit2";
import {CNodeTabbedCanvasView} from "./nodes/CNodeTabbedCanvasView";
import {markSitchDirty, setRenderOne, Sit, UndoManager} from "./Globals";
import {par} from "./par";

const CHANNELS = {
    pan: {label: "Pan / Az", color: "#4af"},
    tilt: {label: "Tilt / El", color: "#fa4"},
};

const otherChannel = key => key === "pan" ? "tilt" : "pan";

// The same point/segment gestures, snapping, context menu, timeline and undo as
// the FOV editor, with two independently scaled curves in a single window.
export class HeadingEditorView extends CNodeCurveEditorView2 {
    constructor(v) {
        super({...v, editorConfig: {
            minX: 0, maxX: Sit.frames, minY: -10, maxY: 10,
            xLabel: "Frame", yLabel: "Pan / Az (°)", points: [0, 0],
        }});
        this.channels = {
            pan: {points: [{x: 0, y: 0}], enabled: true, range: 10},
            tilt: {points: [{x: 0, y: 0}], enabled: true, range: 10},
        };
        this.activeChannel = "pan";
        this.syncKeyframes = false;
        this.keyframePairs = new Map();
        this.controls = {};
        this.createChannelControls();
        this.selectChannel("pan");
    }

    // Each axis has its own range control below; don't create the FOV slider.
    createYRangeSlider() {}

    createChannelControls() {
        const row = document.createElement("div");
        Object.assign(row.style, {position: "absolute", top: "25px", left: "6px", right: "6px",
            display: "flex", gap: "10px", alignItems: "center", justifyContent: "center",
            font: "12px sans-serif", zIndex: "100"});
        row.addEventListener("pointerdown", e => e.stopPropagation());
        this.div.appendChild(row);
        this.channelControls = row;
        for (const [key, {label, color}] of Object.entries(CHANNELS)) {
            const wrap = document.createElement("span");
            wrap.style.color = color;
            const checkbox = document.createElement("input");
            checkbox.type = "checkbox";
            checkbox.checked = true;
            checkbox.title = `Enable ${label} animation`;
            checkbox.setAttribute("aria-label", checkbox.title);
            checkbox.addEventListener("change", () => {
                this.channels[key].enabled = checkbox.checked;
                const other = key === "pan" ? "tilt" : "pan";
                if (!this.channels[this.activeChannel].enabled && this.channels[other].enabled) this.selectChannel(other);
                this.onChange?.();
                markSitchDirty();
                setRenderOne(true);
            });
            const select = document.createElement("button");
            select.type = "button";
            select.textContent = label;
            select.title = `Select ${label} for new keyframes or overlapping curves`;
            Object.assign(select.style, {background: "none", border: "none", padding: "0",
                color: "inherit", font: "inherit", cursor: "pointer"});
            select.addEventListener("click", () => this.selectChannel(key));
            wrap.append(checkbox, select);
            row.appendChild(wrap);

            const slider = document.createElement("input");
            slider.type = "range";
            // Logarithmic range gives useful fine control at narrow zooms.
            slider.min = -1; slider.max = Math.log10(180); slider.step = 0.01; slider.value = 1;
            Object.assign(slider.style, {position: "absolute", top: "68px", bottom: "60px",
                width: "15px", writingMode: "vertical-lr", direction: "rtl", zIndex: "100",
                [key === "pan" ? "left" : "right"]: "0px", accentColor: color});
            slider.addEventListener("pointerdown", e => e.stopPropagation());
            slider.addEventListener("input", () => {
                this.channels[key].range = 10 ** Number(slider.value);
                this.selectChannel(this.activeChannel);
                markSitchDirty();
                setRenderOne(true);
            });
            this.div.appendChild(slider);
            this.controls[key] = {checkbox, slider, select};
        }
        const sync = document.createElement("button");
        sync.type = "button";
        sync.textContent = "Sync Keyframes";
        sync.title = "Pair Pan and Tilt keyframes. Move either curve's points or segments to move their partners in time. Values stay independent.";
        sync.addEventListener("click", () => this.toggleSyncKeyframes());
        row.appendChild(sync);
        this.syncButton = sync;
        this.updateSyncButton();
    }

    selectChannel(key) {
        this.activeChannel = key;
        const channel = this.channels[key];
        this.points = channel.points;
        this.minY = -channel.range; this.maxY = channel.range;
        for (const [name, {select}] of Object.entries(this.controls)) {
            select.setAttribute("aria-pressed", String(name === key));
            select.style.textDecoration = name === key ? "underline" : "none";
        }
        setRenderOne(true);
    }

    captureState() {
        return {channels: JSON.parse(JSON.stringify(this.channels)), activeChannel: this.activeChannel,
            syncKeyframes: this.syncKeyframes};
    }

    updateSyncButton() {
        this.syncButton.setAttribute("aria-pressed", String(this.syncKeyframes));
        this.syncButton.style.backgroundColor = this.syncKeyframes ? "#286090" : "";
        this.syncButton.style.color = this.syncKeyframes ? "white" : "";
    }

    toggleSyncKeyframes() {
        const before = this.captureState();
        this.syncKeyframes = !this.syncKeyframes;
        this.pairKeyframes();
        this.selectChannel(this.activeChannel);
        this.updateSyncButton();
        const after = this.captureState();
        UndoManager?.add({description: "Sync heading keyframes",
            undo: () => this.restoreState(before), redo: () => this.restoreState(after)});
        this.onChange?.();
        markSitchDirty();
        setRenderOne(true);
    }

    curveValueAt(points, frame) {
        if (!points.length) return 0;
        const f = Math.max(points[0].x, Math.min(points[points.length - 1].x, frame));
        return this.interpolateValue(f, points);
    }

    // Insert missing partners at the existing curve value, including disabled
    // channels. Pair by object identity so an entire segment and any neighbors
    // pushed by it retain their partners as their frame coordinates change.
    pairKeyframes() {
        this.keyframePairs.clear();
        if (!this.syncKeyframes) return;
        const {pan, tilt} = this.channels;
        const frames = [...new Set([...pan.points, ...tilt.points].map(p => p.x))].sort((a, b) => a - b);
        const paired = {};
        for (const [key, channel] of Object.entries(this.channels)) {
            const existing = new Map(channel.points.map(p => [p.x, p]));
            paired[key] = frames.map(x => existing.get(x) ?? {x, y: this.curveValueAt(channel.points, x)});
        }
        pan.points = paired.pan;
        tilt.points = paired.tilt;
        pan.points.forEach((point, i) => {
            this.keyframePairs.set(point, tilt.points[i]);
            this.keyframePairs.set(tilt.points[i], point);
        });
    }

    syncEditedChannel(key) {
        if (!this.syncKeyframes) return;
        const points = this.channels[key].points;
        const other = this.channels[otherChannel(key)];
        const current = new Set(points);
        // Sample new partners before moving any existing ones.
        const added = points.filter(p => !this.keyframePairs.has(p)).map(point => ({
            point, partner: {x: point.x, y: this.curveValueAt(other.points, point.x)},
        }));
        other.points = other.points.filter(partner => {
            const point = this.keyframePairs.get(partner);
            if (current.has(point)) return true;
            this.keyframePairs.delete(point);
            this.keyframePairs.delete(partner);
            return false;
        });
        for (const {point, partner} of added) {
            this.keyframePairs.set(point, partner);
            this.keyframePairs.set(partner, point);
            other.points.push(partner);
        }
        for (const point of points) this.keyframePairs.get(point).x = point.x;
        other.points.sort((a, b) => a.x - b.x);
    }

    onPointsChanged() {
        this.syncEditedChannel(this.activeChannel);
        super.onPointsChanged();
    }

    clearedState() {
        const state = this.captureState();
        for (const channel of Object.values(state.channels)) channel.points = [];
        return state;
    }

    getKeyframeFrames() {
        return Object.values(this.channels).flatMap(channel => channel.points.map(p => Math.round(p.x)))
            .filter(f => Number.isFinite(f) && f >= 0 && f < Sit.frames);
    }

    restoreState(state) {
        this.channels = JSON.parse(JSON.stringify(state.channels));
        this.syncKeyframes = state.syncKeyframes ?? false;
        this.pairKeyframes();
        this.updateSyncButton();
        for (const [key, channel] of Object.entries(this.channels)) {
            this.controls[key].checkbox.checked = channel.enabled;
            this.controls[key].slider.value = Math.log10(channel.range);
        }
        this.selectChannel(state.activeChannel ?? "pan");
        this.onChange?.();
        setRenderOne(true);
    }

    findPointAt(x, y) {
        return this.channels?.[this.activeChannel]?.enabled === false ? null : super.findPointAt(x, y);
    }

    findLineAt(x, y) {
        return this.channels?.[this.activeChannel]?.enabled === false ? null : super.findLineAt(x, y);
    }

    pickChannel(e) {
        const rect = this.canvas.getBoundingClientRect();
        const x = e.clientX - rect.left, y = e.clientY - rect.top;
        const original = this.activeChannel;
        // A point takes priority over a crossing line; prefer the selected
        // channel when two points (or two lines) overlap.
        for (const find of ["findPointAt", "findLineAt"]) {
            for (const key of [original, otherChannel(original)]) {
                this.selectChannel(key);
                if (this[find](x, y) !== null) return;
            }
        }
        this.selectChannel(original);
    }

    onMouseDown(e) {
        this.pickChannel(e);
        if (!this.channels[this.activeChannel].enabled) return;
        super.onMouseDown(e);
    }

    onContextMenu(e) {
        this.pickChannel(e);
        super.onContextMenu(e);
    }

    replaceDefaultSentinel() {} // Zero is a real offset, never a sentinel FOV.

    valueAt(key, frame) {
        const channel = this.channels[key];
        if (!channel.enabled) return 0;
        const points = channel.points.filter(p => p.x < Sit.frames);
        return this.curveValueAt(points, frame);
    }

    renderCanvas(frame) {
        CNodeTabbedCanvasView.prototype.renderCanvas.call(this, frame);
        if (!this.visible || !this.channels) return;
        this.maxX = Sit.frames;
        const ctx = this.ctx, w = this.widthPx, h = this.heightPx, m = 60;
        if (w < 240 || h < 160) return;
        const T = c => this.themeColor(c);
        const active = this.activeChannel;
        ctx.fillStyle = T("#000"); ctx.fillRect(0, 0, w, h);
        ctx.font = "11px sans-serif"; ctx.textBaseline = "middle";
        const step = this.calculateStep(this.maxX, w - 2 * m);
        ctx.lineWidth = 1;
        ctx.textAlign = "center";
        for (let f = 0; f <= this.maxX; f += step) {
            const {x} = this.graphToScreen(f, 0);
            ctx.strokeStyle = T("#444"); ctx.beginPath();
            ctx.moveTo(x, m); ctx.lineTo(x, h - m); ctx.stroke();
            ctx.fillStyle = T("#bbb"); ctx.fillText(String(f), x, h - m + 15);
        }
        for (let i = 0; i <= 4; i++) {
            const y = m + i * (h - 2 * m) / 4;
            ctx.strokeStyle = T(i === 2 ? "#aaa" : "#444"); ctx.beginPath();
            ctx.moveTo(m, y); ctx.lineTo(w - m, y); ctx.stroke();
            for (const [key, {color}] of Object.entries(CHANNELS)) {
                ctx.fillStyle = T(color); ctx.textAlign = key === "pan" ? "right" : "left";
                const value = this.channels[key].range * (1 - i / 2);
                ctx.fillText(`${Number(value.toPrecision(3))}°`, key === "pan" ? m - 5 : w - m + 5, y);
            }
        }
        ctx.save(); ctx.beginPath(); ctx.rect(m - 5, m - 5, w - 2 * m + 10, h - 2 * m + 10); ctx.clip();
        for (const [key, {color}] of Object.entries(CHANNELS)) {
            this.selectChannelForDrawing(key);
            const channel = this.channels[key], points = this.getActivePoints();
            ctx.globalAlpha = channel.enabled ? 1 : 0.22;
            ctx.strokeStyle = T(color); ctx.fillStyle = T(color); ctx.lineWidth = active === key ? 2.5 : 1.5;
            if (points.length) {
                ctx.beginPath();
                let s = this.graphToScreen(0, points[0].y); ctx.moveTo(s.x, s.y);
                for (const p of points) { s = this.graphToScreen(p.x, p.y); ctx.lineTo(s.x, s.y); }
                s = this.graphToScreen(this.maxX, points[points.length - 1].y); ctx.lineTo(s.x, s.y); ctx.stroke();
            }
            for (const p of channel.points) {
                const s = this.graphToScreen(p.x, p.y);
                ctx.beginPath(); ctx.arc(s.x, s.y, active === key ? 5 : 4, 0, Math.PI * 2); ctx.fill();
            }
        }
        ctx.globalAlpha = 1;
        for (const [f, color] of [[Sit.aFrame, "#0a0"], [Sit.bFrame, "#a44"], [par.frame, "#ff0"]]) {
            if (f === undefined) continue;
            const {x} = this.graphToScreen(f, 0);
            ctx.strokeStyle = T(color); ctx.lineWidth = 1; ctx.beginPath();
            ctx.moveTo(x, m); ctx.lineTo(x, h - m); ctx.stroke();
        }
        ctx.restore();
        this.selectChannelForDrawing(active);
        ctx.textAlign = "center"; ctx.fillStyle = T("#ddd");
        ctx.fillText("Frame", w / 2, h - 25);
        const hint = this.hintWarning?.() || "Ctrl+click: add point • Drag curves or look view • Zero = base heading";
        ctx.fillStyle = T(this.hintWarning?.() ? "#fa4" : "#bbb");
        ctx.fillText(hint, w / 2, h - 9, w - 16);
        ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
    }

    selectChannelForDrawing(key) {
        this.points = this.channels[key].points;
        this.minY = -this.channels[key].range; this.maxY = this.channels[key].range;
    }
}
