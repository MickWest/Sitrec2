// NoisePatternCharts - canvas drawing for the Noise Pattern Detection window: the lag chart,
// the "where" strip along the timeline, and the pair images. Plain Canvas 2D; every number
// drawn here is also in the Details text or the CSV export.

import {LAG_MIN, SIGNIFICANT_Z} from "./NoisePatternMath";

export const CURVE_COLORS = {
    dark: {"S-Y": "#c8c8c8", "S-Cb": "#4ea1ff", "S-Cr": "#ff6b6b", "A-Yfine": "#7bd88f", "A-Cbmid": "#c792ea"},
    light: {"S-Y": "#555555", "S-Cb": "#1565c0", "S-Cr": "#c62828", "A-Yfine": "#2e7d32", "A-Cbmid": "#6a1b9a"},
};

export function palette(dark) {
    return dark
        ? {bg: "#1b1b1b", text: "#e6e6e6", dim: "#9a9a9a", grid: "#333", shade: "rgba(255,255,255,0.07)", threshold: "#d0a000",
            matched: [60, 220, 90], tested: "#5a5a5a", untested: "#2c2c2c", hatch: "#444", cursor: "#ffeb3b", tick: "#ffd54f"}
        : {bg: "#ffffff", text: "#202020", dim: "#666", grid: "#ddd", shade: "rgba(0,0,0,0.06)", threshold: "#a06000",
            matched: [20, 150, 50], tested: "#b8b8b8", untested: "#eeeeee", hatch: "#c8c8c8", cursor: "#c68a00", tick: "#b26a00"};
}

// Sizes a canvas for its CSS box at the device pixel ratio; returns the 2D context scaled
// so that drawing uses CSS pixels.
export function sizeCanvas(canvas, width, height) {
    const ratio = (typeof window !== "undefined" && window.devicePixelRatio) || 1;
    const w = Math.max(1, Math.round(width)), h = Math.max(1, Math.round(height));
    if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) {
        canvas.width = Math.round(w * ratio);
        canvas.height = Math.round(h * ratio);
    }
    canvas.style.width = `${w}px`;
    canvas.style.height = `${h}px`;
    const ctx = canvas.getContext("2d");
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    return ctx;
}

export const LAG_CHART_MARGIN = {left: 42, right: 10, top: 18, bottom: 28};

// Lag chart: z of each curve against lag. Lags below 17 are shaded (not scored), z = 6 is
// dashed (the significance level), multiples of the period are ticked, peaks are labeled.
export function drawLagChart(ctx, width, height, data) {
    const {curves, lags, verdict, hoverLag, dark, labels} = data;
    const c = palette(dark), colors = dark ? CURVE_COLORS.dark : CURVE_COLORS.light;
    const m = LAG_CHART_MARGIN;
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);
    const w = width - m.left - m.right, h = height - m.top - m.bottom;
    if (!lags?.lmax || w < 40 || h < 30) {
        ctx.fillStyle = c.dim; ctx.font = "12px sans-serif"; ctx.textAlign = "center";
        ctx.fillText(labels.empty, width / 2, height / 2);
        return null;
    }
    const lmax = lags.lmax;
    let zMax = SIGNIFICANT_Z + 4, zMin = -5;
    for (const curve of Object.values(curves ?? {})) {
        if (!curve.z) continue;
        for (const v of curve.z) if (Number.isFinite(v)) { zMax = Math.max(zMax, v); zMin = Math.min(zMin, v); }
    }
    zMax = Math.ceil(zMax * 1.08);
    zMin = Math.max(-20, Math.floor(zMin));
    const x = (lag) => m.left + (lag - 1) / Math.max(1, lmax - 1) * w;
    const y = (z) => m.top + (zMax - z) / (zMax - zMin) * h;
    // not scored
    ctx.fillStyle = c.shade;
    ctx.fillRect(x(1), m.top, x(LAG_MIN) - x(1), h);
    // grid
    ctx.strokeStyle = c.grid; ctx.lineWidth = 1;
    ctx.font = "10px sans-serif"; ctx.fillStyle = c.dim;
    const zStep = niceStep(zMax - zMin, h / 28);
    ctx.textAlign = "right";
    for (let z = Math.ceil(zMin / zStep) * zStep; z <= zMax; z += zStep) {
        ctx.beginPath(); ctx.moveTo(m.left, y(z)); ctx.lineTo(m.left + w, y(z)); ctx.stroke();
        ctx.fillText(String(z), m.left - 4, y(z) + 3);
    }
    const lagStep = niceStep(lmax, w / 60);
    ctx.textAlign = "center";
    for (let L = lagStep; L <= lmax; L += lagStep) {
        ctx.beginPath(); ctx.moveTo(x(L), m.top + h); ctx.lineTo(x(L), m.top + h + 3); ctx.stroke();
        ctx.fillText(String(L), x(L), m.top + h + 13);
    }
    ctx.fillText(labels.xAxis, m.left + w / 2, height - 3);
    ctx.save(); ctx.translate(10, m.top + h / 2); ctx.rotate(-Math.PI / 2); ctx.fillText(labels.yAxis, 0, 0); ctx.restore();
    // significance level
    ctx.strokeStyle = c.threshold; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.moveTo(m.left, y(SIGNIFICANT_Z)); ctx.lineTo(m.left + w, y(SIGNIFICANT_Z)); ctx.stroke();
    ctx.setLineDash([]);
    // multiples of the period
    const P = verdict?.period;
    if (P) {
        ctx.strokeStyle = c.tick; ctx.lineWidth = 2;
        for (let L = P; L <= lmax; L += P) { ctx.beginPath(); ctx.moveTo(x(L), m.top - 6); ctx.lineTo(x(L), m.top); ctx.stroke(); }
        ctx.lineWidth = 1;
    }
    // curves
    ctx.save();
    ctx.beginPath(); ctx.rect(m.left, m.top - 2, w, h + 4); ctx.clip();
    const order = Object.keys(curves ?? {}).sort((a, b) => (a === verdict?.curve) - (b === verdict?.curve));
    for (const name of order) {
        const z = curves[name]?.z;
        if (!z) continue;
        ctx.strokeStyle = colors[name] ?? c.text;
        ctx.lineWidth = name === verdict?.curve ? 2 : 1;
        ctx.beginPath();
        let open = false;
        for (let L = LAG_MIN; L <= lmax; L++) {
            const v = z[L - 1];
            if (!Number.isFinite(v)) { open = false; continue; }
            if (open) ctx.lineTo(x(L), y(v)); else ctx.moveTo(x(L), y(v));
            open = true;
        }
        ctx.stroke();
    }
    ctx.restore();
    // peak labels (verdict curve, or every curve when there is none)
    ctx.font = "10px sans-serif"; ctx.textAlign = "center";
    const labeled = [];
    const peakCurves = verdict?.curve ? [verdict.curve] : Object.keys(curves ?? {});
    for (const name of peakCurves) {
        for (const peak of (curves[name]?.peaks ?? []).slice(0, 6)) {
            if (labeled.some(L => Math.abs(x(L) - x(peak.lag)) < 22)) continue;
            labeled.push(peak.lag);
            ctx.fillStyle = colors[name] ?? c.text;
            ctx.fillText(String(peak.lag), x(peak.lag), Math.max(m.top + 9, y(Math.min(zMax, peak.z)) - 4));
        }
    }
    // legend
    let lx = m.left + 4;
    ctx.textAlign = "left";
    for (const name of Object.keys(curves ?? {})) {
        const label = name + (curves[name]?.period ? ` P=${curves[name].period}` : "");
        const size = ctx.measureText(label).width + 18;
        if (lx + size > width - m.right) break;
        ctx.fillStyle = colors[name] ?? c.text;
        ctx.fillRect(lx, 5, 10, 3);
        ctx.fillStyle = c.text;
        ctx.fillText(label, lx + 13, 10);
        lx += size;
    }
    if (hoverLag) {
        ctx.strokeStyle = c.cursor;
        ctx.beginPath(); ctx.moveTo(x(hoverLag), m.top); ctx.lineTo(x(hoverLag), m.top + h); ctx.stroke();
    }
    return {lagAt: (px) => Math.max(1, Math.min(lmax, Math.round(1 + (px - m.left) / w * Math.max(1, lmax - 1))))};
}

function niceStep(range, maxTicks) {
    const raw = range / Math.max(1, maxTicks);
    const power = Math.pow(10, Math.floor(Math.log10(Math.max(raw, 1e-9))));
    for (const k of [1, 2, 5, 10]) if (k * power >= raw) return Math.max(1, k * power);
    return Math.max(1, 10 * power);
}

// The strip along the timeline: green = matched (brighter = higher score), gray = tested
// without a match, hatched = not tested, yellow = the current frame.
export function drawWhereStrip(ctx, width, height, data) {
    const {byDisplay, frames, displayOf, currentFrame, dark} = data;
    const c = palette(dark);
    ctx.fillStyle = c.untested;
    ctx.fillRect(0, 0, width, height);
    ctx.strokeStyle = c.hatch; ctx.lineWidth = 1;
    for (let k = -height; k < width; k += 6) { ctx.beginPath(); ctx.moveTo(k, height); ctx.lineTo(k + height, 0); ctx.stroke(); }
    if (!byDisplay || !frames) return;
    const columns = Math.max(1, Math.floor(width));
    for (let px = 0; px < columns; px++) {
        const f0 = Math.floor(px * frames / columns), f1 = Math.max(f0 + 1, Math.floor((px + 1) * frames / columns));
        let tested = false, best = -1;
        for (let f = f0; f < f1; f++) {
            const row = displayOf(f) - byDisplay.from;
            if (row < 0 || row >= byDisplay.rows) continue;
            if (byDisplay.tested[row]) tested = true;
            if (byDisplay.matched[row]) best = Math.max(best, byDisplay.score[row]);
        }
        if (best >= 0) {
            const k = Math.max(0.35, Math.min(1, best));
            ctx.fillStyle = `rgb(${c.matched.map(v => Math.round(v * k)).join(",")})`;
            ctx.fillRect(px, 0, 1, height);
        } else if (tested) {
            ctx.fillStyle = c.tested;
            ctx.fillRect(px, 0, 1, height);
        }
    }
    if (Number.isFinite(currentFrame)) {
        const px = (currentFrame + 0.5) / frames * width;
        ctx.fillStyle = c.cursor;
        ctx.fillRect(Math.round(px) - 1, 0, 2, height);
    }
}

export function stripHue(index) {
    return (index * 47) % 360;
}

// Gray residual image -> canvas (optionally with the source columns moved by the dense map
// so that a repeated pattern lines up with the target).
export function residualCanvas(image, shiftAt = null) {
    if (!image || typeof document === "undefined") return null;
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext("2d");
    const data = ctx.createImageData(image.width, image.height);
    for (let y = 0; y < image.height; y++) {
        for (let x = 0; x < image.width; x++) {
            let sx = x;
            if (shiftAt) sx = Math.round(x + shiftAt(x));
            const v = sx >= 0 && sx < image.width ? image.pixels[y * image.width + sx] : 0;
            const o = (y * image.width + x) * 4;
            data.data[o] = data.data[o + 1] = data.data[o + 2] = v;
            data.data[o + 3] = 255;
        }
    }
    ctx.putImageData(data, 0, 0);
    return canvas;
}

// The pair images: target and source side by side, or one at a time (blink), with a box
// of the same color around each confident strip in both frames.
export function drawPairImages(ctx, width, height, data) {
    const {target, source, blink, showSource, boxes, dark, labels, frameWidth} = data;
    const c = palette(dark);
    ctx.fillStyle = c.bg;
    ctx.fillRect(0, 0, width, height);
    if (!target || !source) {
        ctx.fillStyle = c.dim; ctx.font = "12px sans-serif"; ctx.textAlign = "center";
        ctx.fillText(labels.empty, width / 2, height / 2);
        return;
    }
    const panels = blink ? [{image: showSource ? source : target, which: showSource ? "source" : "target"}]
        : [{image: target, which: "target"}, {image: source, which: "source"}];
    const gap = 6;
    const pw = (width - gap * (panels.length - 1)) / panels.length;
    const scale = Math.min(pw / target.width, (height - 14) / target.height);
    const dw = target.width * scale, dh = target.height * scale;
    ctx.imageSmoothingEnabled = false;
    panels.forEach((panel, i) => {
        const x0 = i * (pw + gap) + (pw - dw) / 2, y0 = 14;
        ctx.drawImage(panel.image, x0, y0, dw, dh);
        ctx.fillStyle = c.text; ctx.font = "11px sans-serif"; ctx.textAlign = "left";
        ctx.fillText(labels[panel.which], x0, 10);
        const toPx = dw / frameWidth;
        for (const box of boxes ?? []) {
            const a = panel.which === "target" ? box.x0 : box.sx0, b = panel.which === "target" ? box.x1 : box.sx1;
            if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
            ctx.strokeStyle = `hsl(${box.hue}, 90%, 55%)`;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(x0 + a * toPx, y0 + 1, (b - a) * toPx, dh - 2);
        }
    });
}
